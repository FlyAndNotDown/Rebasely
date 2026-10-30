import type { UpdateState } from "@/types/updater";

type Request = "check" | "install" | "restart";
export type UpdateSnapshot = UpdateState & { request: Request | null };

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
  };
  const listeners = new Set<() => void>();
  let listening = false;
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let operation: Promise<void> | null = null;
  let startup: Promise<void> | null = null;

  function publish(next: UpdateSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function receive(state: UpdateState) {
    if (state.revision < snapshot.revision) return;
    publish({ ...state, request: snapshot.request });
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

  function run(request: Request, action: () => Promise<void>): Promise<void> {
    if (operation) return operation;
    publish({ ...snapshot, request });
    operation = (async () => {
      try {
        await initialize();
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({ ...snapshot, status: "error", error: message.slice(0, 1_000) });
      } finally {
        publish({ ...snapshot, request: null });
        operation = null;
      }
    })();
    return operation;
  }

  function check() {
    if (snapshot.status === "installed" || updateBusy(snapshot) && !operation) return Promise.resolve();
    return run("check", async () => { receive(await client.check()); });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // This store lives for the webview's lifetime, including StrictMode remounts.
    start: () => startup ??= check(),
    check,
    install(version: string) {
      if (operation || updateBusy(snapshot) || snapshot.update?.version !== version) return Promise.resolve();
      return run("install", async () => { receive(await client.install(version)); });
    },
    restart: () => snapshot.status === "installed"
      ? run("restart", () => client.restart())
      : Promise.resolve(),
  };
}
