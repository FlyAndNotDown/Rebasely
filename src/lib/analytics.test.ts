import { describe, expect, it, vi } from "vitest";
import { analyticsInstallId, analyticsSessionAllowed, createAnalyticsController, registerAnalyticsStop, setAnalyticsSessionAllowed } from "./analytics";
import { isAnalyticsEvent, isAnalyticsInit, type AnalyticsEvent, type AnalyticsInit } from "./analytics-protocol";

const ID = "11111111-1111-4111-8111-111111111111";
const GENERATIONS = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

function fixture() {
  let now = 0;
  let generation = 0;
  const installId = vi.fn(() => ID);
  const frames: { init: AnalyticsInit; ready: () => void; error: () => void; events: AnalyticsEvent[]; disable: ReturnType<typeof vi.fn> }[] = [];
  const controller = createAnalyticsController({
    installId,
    randomUUID: () => GENERATIONS[generation++],
    now: () => now,
    sessionId: () => 1_700_000_000,
    platform: "windows",
    appVersion: "1.2.3",
    createBridge(init, callbacks) {
      const frame = { init, ...callbacks, events: [] as AnalyticsEvent[], disable: vi.fn() };
      frames.push(frame);
      return { send: (event) => frame.events.push(event), disable: frame.disable };
    },
  });
  return { controller, frames, installId, time: (value: number) => { now = value; } };
}

describe("desktop analytics privacy", () => {
  it("does not create an identity or frame before preferences load or for a saved opt-out", () => {
    const { controller, frames, installId, time } = fixture();
    controller.configure(false, true);
    controller.setPane("git_history");
    controller.setForeground(true);
    time(10_000);
    controller.pulse();
    controller.configure(true, false);
    expect(frames).toHaveLength(0);
    expect(installId).not.toHaveBeenCalled();
    controller.configure(true, true);
    expect(frames).toHaveLength(1);
    expect(isAnalyticsInit(frames[0].init)).toBe(true);
    frames[0].ready();
    expect(frames[0].events.map((event) => event.event)).toEqual(["app_open", "pane_view"]);
    expect(frames[0].events.every((event) => isAnalyticsEvent(event, frames[0].init.generation))).toBe(true);
  });

  it("drops queued events and stale readiness after opt-out without replaying on opt-in", () => {
    const { controller, frames, time } = fixture();
    controller.setForeground(true);
    controller.configure(true, true);
    time(1_000);
    controller.pulse();
    controller.configure(true, false);
    expect(frames[0].disable).toHaveBeenCalledOnce();
    frames[0].ready();
    controller.setPane("p4_pending");
    time(4_000);
    controller.pulse();
    expect(frames[0].events).toEqual([]);
    controller.configure(true, true);
    frames[0].ready();
    frames[1].ready();
    expect(frames[1].init.generation).not.toBe(frames[0].init.generation);
    expect(frames[1].events).toEqual([
      { type: "event", generation: GENERATIONS[1], event: "app_open" },
      { type: "event", generation: GENERATIONS[1], event: "pane_view", pane: "p4_pending" },
    ]);
  });

  it("measures foreground time only, flushes on blur, and bounds delayed pulses", () => {
    const { controller, frames, time } = fixture();
    controller.configure(true, true);
    frames[0].ready();
    controller.setForeground(true);
    time(2_300);
    controller.pulse();
    time(3_800);
    controller.setForeground(false);
    time(100_000);
    controller.pulse();
    controller.setForeground(true);
    time(102_000);
    controller.pulse();
    time(300_000);
    controller.pulse();
    const durations = frames[0].events.flatMap((event) => event.event === "app_engagement" ? [event.engagementTimeMsec] : []);
    expect(durations).toEqual([2_300, 1_500, 2_000, 60_000]);
  });

  it("bounds startup buffering and fails quietly without retrying a blocked bridge", () => {
    const { controller, frames, time } = fixture();
    controller.setForeground(true);
    controller.configure(true, true);
    for (let index = 1; index <= 100; index += 1) {
      time(index * 1_000);
      controller.pulse();
    }
    frames[0].ready();
    expect(frames[0].events).toHaveLength(16);
    frames[0].error();
    controller.setPane("git_changes");
    controller.configure(true, true);
    expect(frames).toHaveLength(1);
    expect(frames[0].disable).toHaveBeenCalledOnce();
  });

  it("stops synchronously when the Settings choice changes, even if persistence fails", () => {
    const stop = vi.fn();
    const unsubscribe = registerAnalyticsStop(stop);
    try {
      setAnalyticsSessionAllowed(false);
      expect(stop).toHaveBeenCalledOnce();
      expect(analyticsSessionAllowed()).toBe(false);
    } finally {
      unsubscribe();
      setAnalyticsSessionAllowed(true);
    }
  });
});

describe("installation identity", () => {
  it("reuses only a random UUID and never derives one from environment information", () => {
    const random = vi.fn(() => ID);
    const storage = { getItem: vi.fn(() => ID), setItem: vi.fn() };
    expect(analyticsInstallId(storage, random)).toBe(ID);
    expect(random).not.toHaveBeenCalled();
    storage.getItem.mockReturnValue("invalid old value");
    expect(analyticsInstallId(storage, random)).toBe(ID);
    expect(storage.setItem).toHaveBeenCalledWith("rebasely.analytics.install-id", ID);
  });

  it("uses an ephemeral random ID if storage is unavailable", () => {
    const storage = { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); } };
    expect(analyticsInstallId(storage, () => ID)).toBe(ID);
  });
});
