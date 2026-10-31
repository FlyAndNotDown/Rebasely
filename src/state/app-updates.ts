import type { UpdateState } from "@/types/updater";

type Request = "check" | "install" | "restart";
export type UpdateNotice =
  | { id: number; kind: "available"; version: string }
  | { id: number; kind: "installed" }
  | { id: number; kind: "error"; request: Request; message: string };
export type UpdateSnapshot = UpdateState & { request: Request | null; notice: UpdateNotice | null };

export interface UpdateClient {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  install(version: string): Promise<UpdateState>;
  restart(): Promise<void>;
  subscribe(listener: (state: UpdateState) => void): Promise<() => void>;
}

export function updateBusy(state: UpdateSnapshot): boolean {
  return state.request !== null || ["checking", "downloading", "installing"].includes(state.status);
}

export function createUpdateStore(client: UpdateClient) {
  let snapshot: UpdateSnapshot = {
    revision: 0,
    status: "idle",
    update: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    request: null,
    notice: null,
  };
  const listeners = new Set<() => void>();
  let listening = false;
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let operation: Promise<void> | null = null;
  let startup: Promise<void> | null = null;
  let interactive = false;
  let noticeId = 0;
  const announcedVersions = new Set<string>();
  let announcedInstalled = false;

  function notification(request: Request | null, notifyErrors: boolean): UpdateNotice | null {
    if (snapshot.status === "available" && snapshot.update && !announcedVersions.has(snapshot.update.version)) {
      announcedVersions.add(snapshot.update.version);
      return { id: ++noticeId, kind: "available", version: snapshot.update.version };
    }
    if (snapshot.status === "installed" && !snapshot.error && !announcedInstalled) {
      announcedInstalled = true;
      return { id: ++noticeId, kind: "installed" };
    }
    if (notifyErrors && request && snapshot.error) {
      return { id: ++noticeId, kind: "error", request, message: snapshot.error };
    }
    return null;
  }

  function publish(next: UpdateSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function receive(state: UpdateState) {
    if (state.revision < snapshot.revision) return;
    snapshot = { ...state, request: snapshot.request, notice: snapshot.notice };
    publish({ ...snapshot, notice: snapshot.request === null ? notification(null, false) ?? snapshot.notice : snapshot.notice });
  }

  function initialize(): Promise<void> {
    if (initialized) return Promise.resolve();
    if (initialization) return initialization;
    initialization = (async () => {
      if (!listening) {
        await client.subscribe(receive);
        listening = true;
      }
      receive(await client.getState());
      initialized = true;
    })().finally(() => { initialization = null; });
    return initialization;
  }

  function run(request: Request, action: () => Promise<void>, background = false): Promise<void> {
    if (operation) {
      if (!background) interactive = true;
      return operation;
    }
    interactive = !background;
    publish({ ...snapshot, request, error: null, notice: null });
    operation = (async () => {
      try {
        await initialize();
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({ ...snapshot, status: request === "restart" ? "installed" : "error", error: message.slice(0, 1_000) });
      } finally {
        operation = null;
        publish({ ...snapshot, request: null, notice: notification(request, interactive) });
      }
    })();
    return operation;
  }

  function check(background = false) {
    if (snapshot.status === "installed" || updateBusy(snapshot) && !operation) return Promise.resolve();
    return run("check", async () => { receive(await client.check()); }, background);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // This store lives for the webview's lifetime, including StrictMode remounts.
    start: () => startup ??= check(true),
    check: () => check(),
    dismissNotice(id: number) {
      if (snapshot.notice?.id === id) publish({ ...snapshot, notice: null });
    },
    install(version: string) {
      if (operation || updateBusy(snapshot) || !["available", "error"].includes(snapshot.status) || snapshot.update?.version !== version) return Promise.resolve();
      return run("install", async () => { receive(await client.install(version)); });
    },
    restart: () => snapshot.status === "installed" && !updateBusy(snapshot)
      ? run("restart", () => client.restart())
      : Promise.resolve(),
  };
}
