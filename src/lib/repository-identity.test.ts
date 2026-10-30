import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitApi } from "@/lib/git";
import { createRepositoryIdentitySession } from "./repository-identity";
import type { GitIdentity } from "@/types/git";

const globalIdentity = { name: "alice", email: "alice@example.com" };
const localIdentity = { name: "project author", email: "" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(gitApi, "getGitIdentity").mockResolvedValue(globalIdentity);
  vi.spyOn(gitApi, "getLocalGitIdentity").mockResolvedValue(localIdentity);
  vi.spyOn(gitApi, "setLocalGitIdentity").mockResolvedValue(localIdentity);
});
afterEach(() => vi.restoreAllMocks());

describe("repository identity dialog sessions", () => {
  it("inherits only missing local fields and stores only global overrides", async () => {
    const session = createRepositoryIdentitySession("/repos/project");
    expect(await session.load()).toEqual({ global: globalIdentity, value: { name: localIdentity.name, email: globalIdentity.email } });
    expect(await session.save({ name: " project author ", email: ` ${globalIdentity.email} ` }, globalIdentity)).toBe(true);
    expect(gitApi.setLocalGitIdentity).toHaveBeenCalledWith("/repos/project", { name: "project author", email: "" });
  });

  it("ignores a late identity read after another repository's dialog opens", async () => {
    const pending = deferred<GitIdentity>();
    vi.mocked(gitApi.getLocalGitIdentity).mockReturnValueOnce(pending.promise);
    const previous = createRepositoryIdentitySession("/repos/previous");
    const load = previous.load();
    previous.dispose();
    const current = createRepositoryIdentitySession("/repos/current");
    expect(await current.load()).not.toBeNull();
    pending.resolve({ name: "stale author", email: "stale@example.com" });
    expect(await load).toBeNull();
  });

  it("saves to the original repository without dismissing a later dialog", async () => {
    const pending = deferred<GitIdentity>();
    vi.mocked(gitApi.setLocalGitIdentity).mockReturnValueOnce(pending.promise);
    const previous = createRepositoryIdentitySession("/repos/previous");
    const save = previous.save(localIdentity, globalIdentity);
    previous.dispose();
    pending.resolve(localIdentity);
    expect(await save).toBe(false);
    expect(gitApi.setLocalGitIdentity).toHaveBeenCalledWith("/repos/previous", { name: localIdentity.name, email: "" });
    await previous.save(localIdentity, globalIdentity);
    expect(gitApi.setLocalGitIdentity).toHaveBeenCalledOnce();
  });

  it("reports current load errors and suppresses errors from a closed dialog", async () => {
    vi.mocked(gitApi.getLocalGitIdentity).mockRejectedValueOnce(new Error("Read failed"));
    await expect(createRepositoryIdentitySession("/repos/current").load()).rejects.toThrow("Read failed");
    const pending = deferred<GitIdentity>();
    vi.mocked(gitApi.getLocalGitIdentity).mockReturnValueOnce(pending.promise);
    const previous = createRepositoryIdentitySession("/repos/previous");
    const load = previous.load();
    previous.dispose();
    pending.reject(new Error("Stale read failed"));
    await expect(load).resolves.toBeNull();
  });
});
