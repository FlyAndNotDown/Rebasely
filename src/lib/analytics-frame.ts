import { ANALYTICS_BRIDGE_URL, isAnalyticsEvent, isAnalyticsReply, type AnalyticsInit } from "./analytics-protocol";
import type { AnalyticsBridge } from "./analytics";

export function createAnalyticsFrame(init: AnalyticsInit, callbacks: { ready: () => void; error: () => void }): AnalyticsBridge {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.sandbox.add("allow-scripts", "allow-same-origin");
  frame.referrerPolicy = "no-referrer";
  frame.src = ANALYTICS_BRIDGE_URL;
  let port: MessagePort | null = null;
  let disabling = false;
  let removed = false;
  let timeout = window.setTimeout(fail, 10_000);

  function remove() {
    if (removed) return;
    removed = true;
    window.clearTimeout(timeout);
    frame.onload = null;
    frame.onerror = null;
    port?.close();
    frame.remove();
  }
  function disable() {
    if (disabling || removed) return;
    disabling = true;
    window.clearTimeout(timeout);
    if (!port) { remove(); return; }
    // Let the bridge disable gtag before removing it, avoiding an unload ping.
    port.postMessage({ type: "disable", generation: init.generation });
    timeout = window.setTimeout(remove, 2_000);
  }
  function fail() {
    disable();
    callbacks.error();
  }
  frame.onerror = fail;
  frame.onload = () => {
    if (disabling || removed || !frame.contentWindow) return;
    try {
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!isAnalyticsReply(data, init.generation)) return;
        if (data.type === "disabled") { remove(); return; }
        if (disabling || removed) return;
        if (data.type === "error") { fail(); return; }
        window.clearTimeout(timeout);
        callbacks.ready();
      };
      port.start();
      frame.contentWindow.postMessage(init, new URL(ANALYTICS_BRIDGE_URL).origin, [channel.port2]);
    } catch { fail(); }
  };
  document.body.append(frame);
  return {
    send(event) { if (!disabling && !removed && isAnalyticsEvent(event, init.generation)) port?.postMessage(event); },
    disable,
  };
}
