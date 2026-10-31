import { describe, expect, it, vi } from "vitest";
import { installAnalyticsBridge, type AnalyticsTag } from "./analytics-bridge";
import type { AnalyticsInit } from "../../src/lib/analytics-protocol";

const init: AnalyticsInit = {
  type: "rebasely:analytics:init", protocol: 1,
  generation: "099a2525-4c0c-41e6-9969-9ecf6d4e26c7",
  clientId: "245bbf45-cbda-49cd-b1d6-d580fe56a85e", sessionId: 1_700_000_000,
  platform: "windows", appVersion: "1.2.3",
};

function harness() {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const order: string[] = [];
  const parent = {};
  const host = {
    parent,
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.get(type)?.delete(listener); },
  } as unknown as Window;
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn((message: { type: string }) => { order.push(message.type); }),
    start: vi.fn(), close: vi.fn(),
  };
  let resolve!: () => void;
  let reject!: () => void;
  const tag: AnalyticsTag = {
    ready: new Promise<void>((accept, fail) => { resolve = accept; reject = () => fail(new Error("private diagnostic")); }),
    send: vi.fn(), disable: vi.fn(() => { order.push("disable"); }),
  };
  const createTag = vi.fn(() => tag);
  const dispose = installAnalyticsBridge(host, createTag);
  const message = (data: unknown, extra: Partial<MessageEvent> = {}) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ data, origin: "tauri://localhost", source: parent, ports: [port], ...extra } as MessageEvent);
    }
  };
  const event = (data: unknown) => port.onmessage?.({ data } as MessageEvent);
  return { message, event, port, tag, createTag, resolve, reject, order, dispose };
}

describe("hosted analytics lifecycle", () => {
  it("stays inert for untrusted, malformed or multi-port initial messages", () => {
    const bridge = harness();
    bridge.message(init, { origin: "https://example.com" });
    bridge.message(init, { source: {} as Window });
    bridge.message(init, { ports: [] });
    bridge.message({ ...init, path: "/private/project" });
    expect(bridge.createTag).not.toHaveBeenCalled();
    expect(bridge.port.start).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("accepts one handshake and sends only validated events after readiness", async () => {
    const bridge = harness();
    bridge.message(init);
    bridge.message(init);
    const event = { type: "event", generation: init.generation, event: "app_open" };
    bridge.event(event);
    expect(bridge.tag.send).not.toHaveBeenCalled();
    bridge.resolve();
    await Promise.resolve();
    expect(bridge.createTag).toHaveBeenCalledExactlyOnceWith(init);
    expect(bridge.port.postMessage).toHaveBeenCalledWith({ type: "ready", generation: init.generation });
    bridge.event({ ...event, generation: "stale" });
    bridge.event({ ...event, repository: "private-project" });
    expect(bridge.tag.send).not.toHaveBeenCalled();
    bridge.event(event);
    expect(bridge.tag.send).toHaveBeenCalledExactlyOnceWith(event);
    bridge.dispose();
  });

  it("disables before acknowledging even while the script is loading", async () => {
    const bridge = harness();
    bridge.message(init);
    bridge.event({ type: "disable", generation: init.generation });
    expect(bridge.order).toEqual(["disable", "disabled"]);
    bridge.resolve();
    await Promise.resolve();
    bridge.event({ type: "event", generation: init.generation, event: "app_open" });
    expect(bridge.tag.send).not.toHaveBeenCalled();
    expect(bridge.port.postMessage).not.toHaveBeenCalledWith({ type: "ready", generation: init.generation });
    bridge.dispose();
  });

  it("disables on failure before returning a generic error", async () => {
    const bridge = harness();
    bridge.message(init);
    bridge.reject();
    await Promise.resolve();
    expect(bridge.order).toEqual(["disable", "error"]);
    expect(bridge.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "error", generation: init.generation });
    bridge.dispose();
    expect(bridge.port.close).toHaveBeenCalledOnce();
  });
});
