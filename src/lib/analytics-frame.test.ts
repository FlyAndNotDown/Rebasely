import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalyticsFrame } from "./analytics-frame";
import { ANALYTICS_BRIDGE_URL, type AnalyticsInit } from "./analytics-protocol";

const init: AnalyticsInit = {
  type: "rebasely:analytics:init", protocol: 1,
  generation: "22222222-2222-4222-8222-222222222222",
  clientId: "11111111-1111-4111-8111-111111111111",
  sessionId: 1_700_000_000, platform: "windows", appVersion: "1.2.3",
};

function fixture() {
  vi.useFakeTimers();
  const port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  const transfer = {};
  const frame = {
    hidden: false, tabIndex: 0, referrerPolicy: "", src: "",
    setAttribute: vi.fn(), sandbox: { add: vi.fn() },
    contentWindow: { postMessage: vi.fn() },
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    remove: vi.fn(),
  };
  const append = vi.fn();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("document", { createElement: vi.fn(() => frame), body: { append } });
  vi.stubGlobal("MessageChannel", class { port1 = port; port2 = transfer; });
  const ready = vi.fn();
  const error = vi.fn();
  const bridge = createAnalyticsFrame(init, { ready, error });
  return { bridge, frame, port, transfer, append, ready, error };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isolated analytics frame", () => {
  it("sends identifiers through one exact-origin channel, never in the frame URL or referrer", () => {
    const { frame, transfer, append } = fixture();
    expect(frame.src).toBe(ANALYTICS_BRIDGE_URL);
    expect(frame.referrerPolicy).toBe("no-referrer");
    expect(frame.hidden).toBe(true);
    expect(frame.sandbox.add).toHaveBeenCalledWith("allow-scripts", "allow-same-origin");
    expect(append).toHaveBeenCalledWith(frame);
    frame.onload?.();
    expect(frame.contentWindow.postMessage).toHaveBeenCalledWith(init, new URL(ANALYTICS_BRIDGE_URL).origin, [transfer]);
  });

  it("removes a disabled frame before load without initializing a channel", () => {
    const { bridge, frame } = fixture();
    bridge.disable();
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(frame.onload).toBeNull();
    expect(frame.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it("rejects stale replies and invalid payloads, then waits for disable acknowledgment before removal", () => {
    const { bridge, frame, port, ready } = fixture();
    frame.onload?.();
    port.onmessage?.({ data: { type: "ready", generation: "old" } });
    expect(ready).not.toHaveBeenCalled();
    port.onmessage?.({ data: { type: "ready", generation: init.generation } });
    expect(ready).toHaveBeenCalledOnce();
    const event = { type: "event", generation: init.generation, event: "app_open" } as const;
    bridge.send({ ...event, path: "/private/project" } as typeof event);
    expect(port.postMessage).not.toHaveBeenCalled();
    bridge.send(event);
    expect(port.postMessage).toHaveBeenCalledWith(event);
    bridge.disable();
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "disable", generation: init.generation });
    expect(frame.remove).not.toHaveBeenCalled();
    bridge.send(event);
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    port.onmessage?.({ data: { type: "disabled", generation: init.generation } });
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("cleans up an unavailable bridge without retrying or holding an iframe indefinitely", () => {
    const { frame, error } = fixture();
    vi.advanceTimersByTime(10_000);
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
