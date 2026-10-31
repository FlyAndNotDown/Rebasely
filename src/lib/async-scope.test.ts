import { describe, expect, it, vi } from "vitest";
import { createExclusiveAction, createLatestRequest } from "./async-scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

describe("scoped resources", () => {
  it("ignores old path/auth results and late errors after a replacement or close", async () => {
    const request = createLatestRequest();
    const oldServer = deferred<string[]>();
    const newServer = deferred<string[]>();
    const complete = vi.fn();
    const failed = vi.fn();
    request.run(() => oldServer.promise, complete, failed);
    const close = request.run(() => newServer.promise, complete, failed);
    newServer.resolve(["//depot/new"]);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(["//depot/new"]));
    oldServer.reject(new Error("Old connection failed"));
    close();
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    const closed = deferred<string[]>();
    request.run(() => closed.promise, complete, failed)();
    closed.resolve(["//depot/closed"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("publishes a current failure and allows an explicit retry to succeed", async () => {
    const request = createLatestRequest();
    const failed = vi.fn();
    const complete = vi.fn();
    request.run(async () => { throw new Error("Unavailable"); }, complete, failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    request.run(async () => ["//depot/main"], complete, failed);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(["//depot/main"]));
  });
});

describe("exclusive mutations", () => {
  it("rejects duplicate clicks synchronously and releases after failure for retry", async () => {
    const exclusive = createExclusiveAction();
    const pending = deferred<void>();
    const action = vi.fn(() => pending.promise);
    const first = exclusive.run(action);
    expect(exclusive.busy).toBe(true);
    expect(await exclusive.run(action)).toBe(false);
    expect(action).toHaveBeenCalledOnce();
    pending.reject(new Error("Dirty worktree"));
    await expect(first).rejects.toThrow("Dirty worktree");
    expect(exclusive.busy).toBe(false);
    expect(await exclusive.run(async () => {})).toBe(true);
  });
});
