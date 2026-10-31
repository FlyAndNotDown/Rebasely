import {
  isAnalyticsDisable, isAnalyticsEvent, isAnalyticsInit, isTrustedAnalyticsParent,
  type AnalyticsEvent, type AnalyticsInit, type AnalyticsReply,
} from "../../src/lib/analytics-protocol";

export interface AnalyticsTag {
  ready: Promise<void>;
  send(event: AnalyticsEvent): void;
  disable(): void;
}

export function installAnalyticsBridge(host: Window, createTag: (init: AnalyticsInit) => AnalyticsTag) {
  let port: MessagePort | null = null;
  let tag: AnalyticsTag | null = null;
  let generation = "";
  let state: "waiting" | "starting" | "ready" | "disabled" = "waiting";

  const reply = (type: AnalyticsReply["type"]) => port?.postMessage({ type, generation } satisfies AnalyticsReply);
  const disable = () => {
    state = "disabled";
    tag?.disable();
  };
  const fail = () => {
    if (state === "disabled") return;
    disable();
    reply("error");
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (state !== "waiting"
      || !isTrustedAnalyticsParent(event.origin, event.source, host.parent, host)
      || !isAnalyticsInit(event.data) || event.ports.length !== 1) return;
    const init = event.data;
    state = "starting";
    generation = init.generation;
    host.removeEventListener("message", receive);
    port = event.ports[0];
    port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (isAnalyticsDisable(data, generation)) {
        // Stop collection before the parent receives permission to remove us.
        disable();
        reply("disabled");
      } else if (state === "ready" && isAnalyticsEvent(data, generation)) {
        try { tag?.send(data); } catch { fail(); }
      }
    };
    port.start();
    try {
      tag = createTag(init);
      void tag.ready.then(() => {
        if (state !== "starting") return;
        state = "ready";
        reply("ready");
      }, fail);
    } catch { fail(); }
  };
  host.addEventListener("message", receive);
  // This listener exists before the remote tag registers unload handlers.
  host.addEventListener("pagehide", disable);
  return () => {
    disable();
    host.removeEventListener("message", receive);
    host.removeEventListener("pagehide", disable);
    if (port) {
      port.onmessage = null;
      port.close();
    }
  };
}
