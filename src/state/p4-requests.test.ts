import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBinaryDiff } from "@/lib/git";
import { P4_LOGIN, p4Api } from "@/lib/p4";
import type { P4Connection } from "@/types/p4";
import { pendingDiffRequest, withP4Login } from "./p4-requests";

const connection: P4Connection = {
  root: "C:\\work\\client", port: "ssl:perforce.example.com:1666", user: "alice", client: "dev-pc",
  charset: "utf8", stream: null, server: "",
};

afterEach(() => vi.restoreAllMocks());

describe("Perforce credential retries", () => {
  it("creates a fresh opened-file diff request after logging in", async () => {
    const diff = emptyBinaryDiff("a.bin");
    const opened = vi.spyOn(p4Api, "openedDiff").mockRejectedValueOnce(new Error(P4_LOGIN)).mockResolvedValueOnce(diff);
    const login = vi.fn(async () => { expect(opened).toHaveBeenCalledTimes(1); });
    const request = pendingDiffRequest(connection, "42", "//depot/main/a.bin", false);

    expect(opened).not.toHaveBeenCalled();
    expect(await withP4Login(request, login)).toBe(diff);
    expect(login).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenLastCalledWith(connection, "//depot/main/a.bin");
  });

  it("retries a shelved-file diff with its original changelist", async () => {
    const diff = emptyBinaryDiff("a.bin");
    const shelved = vi.spyOn(p4Api, "shelfDiff").mockRejectedValueOnce(P4_LOGIN).mockResolvedValueOnce(diff);
    expect(await withP4Login(pendingDiffRequest(connection, "42", "//depot/main/a.bin", true), async () => {})).toBe(diff);
    expect(shelved).toHaveBeenCalledTimes(2);
    expect(shelved).toHaveBeenLastCalledWith(connection, "//depot/main/a.bin", "42");
  });

  it("does not retry unrelated failures or a cancelled login", async () => {
    const login = vi.fn();
    const failed = vi.fn().mockRejectedValue(new Error("Unavailable"));
    await expect(withP4Login(failed, login)).rejects.toThrow("Unavailable");
    expect(login).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();

    const expired = vi.fn().mockRejectedValue(new Error(P4_LOGIN));
    await expect(withP4Login(expired, async () => { throw new Error("Login cancelled"); })).rejects.toThrow("Login cancelled");
    expect(expired).toHaveBeenCalledOnce();
  });
});
