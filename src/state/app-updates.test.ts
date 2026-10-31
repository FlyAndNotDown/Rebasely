import { describe, expect, it, vi } from "vitest";
import { createUpdateStore, type UpdateClient } from "./app-updates";
import type { UpdateState } from "@/types/updater";

function state(revision: number, status: UpdateState["status"]): UpdateState {
  return {
    revision, status, downloadedBytes: 0, totalBytes: null, error: null,
    update: ["available", "downloading", "installed"].includes(status)
      ? { version: "0.0.2", currentVersion: "0.0.1", notes: "Changes", publishedAt: null }
      : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let receive: (state: UpdateState) => void = () => {};
  const client = {
    getState: vi.fn(async () => state(0, "idle")),
    check: vi.fn(async () => state(2, "current")),
    install: vi.fn(async (_version: string) => state(5, "installed")),
    restart: vi.fn(async () => {}),
    subscribe: vi.fn(async (listener: (state: UpdateState) => void) => {
      receive = listener;
      return () => {};
    }),
  } satisfies UpdateClient;
  return { client, store: createUpdateStore(client), emit: (value: UpdateState) => receive(value) };
}

describe("application update lifecycle", () => {
  it("checks once on startup, survives remounts, and never polls", async () => {
    vi.useFakeTimers();
    try {
      const { client, store } = fixture();
      const first = store.start();
      expect(store.start()).toBe(first);
      await first;
      const unsubscribe = store.subscribe(() => {});
      unsubscribe();
      store.subscribe(() => {});
      await store.start();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(client.check).toHaveBeenCalledTimes(1);
      expect(client.subscribe).toHaveBeenCalledTimes(1);
      await store.check();
      expect(client.check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not check merely because Settings subscribes", () => {
    const { client, store } = fixture();
    store.subscribe(() => {});
    store.getSnapshot();
    expect(client.check).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it("ignores old snapshots returned after newer native events", async () => {
    const { client, store, emit } = fixture();
    const initial = deferred<UpdateState>();
    client.getState.mockReturnValue(initial.promise);
    const start = store.start();
    await vi.waitFor(() => expect(client.getState).toHaveBeenCalled());
    emit(state(3, "available"));
    initial.resolve(state(0, "idle"));
    await start;
    expect(store.getSnapshot().status).toBe("available");
    expect(store.getSnapshot().revision).toBe(3);
    emit(state(1, "checking"));
    expect(store.getSnapshot().status).toBe("available");
  });

  it("coalesces duplicate checks", async () => {
    const { client, store } = fixture();
    const result = deferred<UpdateState>();
    client.check.mockReturnValue(result.promise);
    const first = store.check();
    expect(store.check()).toBe(first);
    await vi.waitFor(() => expect(client.check).toHaveBeenCalledTimes(1));
    result.resolve(state(2, "available"));
    await first;
    expect(store.getSnapshot().request).toBeNull();
  });

  it("retries initialization after an IPC failure", async () => {
    const { client, store } = fixture();
    client.subscribe.mockRejectedValueOnce(new Error("Updates unavailable"));
    await store.start();
    expect(store.getSnapshot().error).toBe("Updates unavailable");
    expect(store.getSnapshot().request).toBeNull();
    await store.check();
    expect(client.check).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).toBe("current");
  });

  it("installs only the reviewed version and prevents concurrent mutations", async () => {
    const { client, store, emit } = fixture();
    client.check.mockResolvedValue(state(2, "available"));
    await store.start();
    await store.install("0.0.3");
    expect(client.install).not.toHaveBeenCalled();
    const download = deferred<UpdateState>();
    client.install.mockReturnValue(download.promise);
    const install = store.install("0.0.2");
    await store.install("0.0.2");
    await vi.waitFor(() => expect(client.install).toHaveBeenCalledTimes(1));
    emit(state(4, "downloading"));
    expect(store.getSnapshot().request).toBe("install");
    download.resolve(state(5, "installed"));
    await install;
    await store.check();
    expect(client.check).toHaveBeenCalledTimes(1);
    await store.restart();
    expect(client.restart).toHaveBeenCalledTimes(1);
  });

  it("retains a checked update after an install error so the owner can retry", async () => {
    const { client, store } = fixture();
    client.check.mockResolvedValue(state(2, "available"));
    await store.start();
    client.install.mockRejectedValueOnce("Download failed");
    await store.install("0.0.2");
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: "Download failed", request: null });
    expect(store.getSnapshot().update?.version).toBe("0.0.2");
    await store.install("0.0.2");
    expect(client.install).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().status).toBe("installed");
  });

  it("keeps background failures quiet and allows an interactive retry", async () => {
    const { client, store } = fixture();
    client.check.mockResolvedValueOnce({ ...state(2, "error"), error: "Connection failed" });
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: "Connection failed", notice: null });
    client.check.mockResolvedValueOnce({ ...state(4, "error"), error: "Try another connection" });
    await store.check();
    expect(store.getSnapshot().notice).toMatchObject({ kind: "error", request: "check", message: "Try another connection" });
  });

  it("announces a startup update once and does not restore a dismissed notice", async () => {
    const { client, store, emit } = fixture();
    client.check.mockResolvedValue(state(2, "available"));
    await store.start();
    const notice = store.getSnapshot().notice!;
    expect(notice).toMatchObject({ kind: "available", version: "0.0.2" });
    store.dismissNotice(notice.id + 1);
    expect(store.getSnapshot().notice).toBe(notice);
    store.dismissNotice(notice.id);
    emit(state(3, "available"));
    expect(store.getSnapshot().notice).toBeNull();
    await store.start();
    expect(client.check).toHaveBeenCalledTimes(1);
  });

  it("reports a shared startup check failure if the user explicitly requests it", async () => {
    const { client, store } = fixture();
    const result = deferred<UpdateState>();
    client.check.mockReturnValue(result.promise);
    const background = store.start();
    await vi.waitFor(() => expect(client.check).toHaveBeenCalledTimes(1));
    expect(store.check()).toBe(background);
    result.resolve({ ...state(2, "error"), error: "Connection failed" });
    await background;
    expect(store.getSnapshot().notice).toMatchObject({ kind: "error", request: "check" });
  });

  it("releases a completed request before subscribers start installation", async () => {
    const { client, store } = fixture();
    client.check.mockResolvedValue(state(2, "available"));
    const download = deferred<UpdateState>();
    client.install.mockReturnValue(download.promise);
    let installed = false;
    store.subscribe(() => {
      if (!installed && store.getSnapshot().notice?.kind === "available") {
        installed = true;
        void store.install("0.0.2");
      }
    });
    await store.start();
    await vi.waitFor(() => expect(client.install).toHaveBeenCalledTimes(1));
    expect(store.getSnapshot().request).toBe("install");
    download.resolve(state(5, "installed"));
    await vi.waitFor(() => expect(store.getSnapshot().notice?.kind).toBe("installed"));
  });

  it("prevents reentrant restart and preserves a failed restart decision for retry", async () => {
    const { client, store, emit } = fixture();
    await store.start();
    emit(state(5, "installed"));
    client.restart.mockRejectedValueOnce(new Error("Restart failed"));
    store.subscribe(() => {
      if (store.getSnapshot().request === "restart") void store.restart();
    });
    await store.restart();
    expect(client.restart).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: "installed", request: null, notice: { kind: "error", request: "restart" } });
    await store.restart();
    expect(client.restart).toHaveBeenCalledTimes(2);
  });
});
