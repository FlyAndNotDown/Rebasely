import { describe, expect, it } from "vitest";
import {
  ANALYTICS_PANES, isAnalyticsDisable, isAnalyticsEvent, isAnalyticsInit,
  isAnalyticsReply, isAnalyticsVersion, isTrustedAnalyticsParent, type AnalyticsInit,
} from "./analytics-protocol";

const generation = "099a2525-4c0c-41e6-9969-9ecf6d4e26c7";
const init: AnalyticsInit = {
  type: "rebasely:analytics:init", protocol: 1, generation,
  clientId: "245bbf45-cbda-49cd-b1d6-d580fe56a85e", sessionId: 1_700_000_000,
  platform: "windows", appVersion: "1.2.3-beta.1+build.2",
};

describe("analytics bridge contract", () => {
  it("accepts exact app metadata and fixed event shapes", () => {
    expect(isAnalyticsInit(init)).toBe(true);
    expect(isAnalyticsEvent({ type: "event", generation, event: "app_open" }, generation)).toBe(true);
    for (const pane of ANALYTICS_PANES) {
      expect(isAnalyticsEvent({ type: "event", generation, event: "pane_view", pane }, generation)).toBe(true);
    }
    for (const engagementTimeMsec of [1, 60_000]) {
      expect(isAnalyticsEvent({ type: "event", generation, event: "app_engagement", engagementTimeMsec }, generation)).toBe(true);
    }
  });

  it("rejects arbitrary identifiers, metadata and malformed handshakes", () => {
    for (const patch of [
      { protocol: 2 }, { generation: "not-random" }, { clientId: "alice@example.com" },
      { sessionId: 0 }, { sessionId: 1.5 }, { sessionId: Number.MAX_SAFE_INTEGER + 1 },
      { platform: "unknown" }, { appVersion: "1.2.3\n" }, { appVersion: "x".repeat(65) },
      { repository: "private-project" },
    ]) expect(isAnalyticsInit({ ...init, ...patch })).toBe(false);
    for (const value of [null, [], new Date(), Object.create(init)]) expect(isAnalyticsInit(value)).toBe(false);
    expect(isAnalyticsVersion("01.2.3")).toBe(false);
    expect(isAnalyticsVersion("1.2.3-01")).toBe(false);
    expect(isAnalyticsVersion("1.2.3-beta.01")).toBe(false);
  });

  it("rejects unapproved event fields, panes, durations and stale generations", () => {
    for (const value of [
      { event: "app_open", path: "/private/file" },
      { event: "app_open", pane: "welcome" },
      { event: "pane_view", pane: "private-project" },
      { event: "pane_view", pane: "welcome", title: "private-project" },
      { event: "app_engagement", engagementTimeMsec: 0 },
      { event: "app_engagement", engagementTimeMsec: 60_001 },
      { event: "app_engagement", engagementTimeMsec: 1.5 },
      { event: "app_engagement", engagementTimeMsec: NaN },
      { event: "custom_event" },
    ]) expect(isAnalyticsEvent({ type: "event", generation, ...value }, generation)).toBe(false);
    expect(isAnalyticsEvent({ type: "event", generation, event: "app_open" }, "stale")).toBe(false);
    expect(isAnalyticsDisable({ type: "disable", generation, extra: true }, generation)).toBe(false);
    expect(isAnalyticsReply({ type: "ready", generation, details: "extra" }, generation)).toBe(false);
    expect(isAnalyticsReply({ type: "error", generation }, "stale")).toBe(false);
  });

  it("trusts only the actual parent at exact native or local QA origins", () => {
    const parent = {};
    const self = {};
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"]) {
      expect(isTrustedAnalyticsParent(origin, parent, parent, self)).toBe(true);
    }
    for (const origin of ["null", "https://example.com", "http://localhost:1421", "http://localhost:1420.evil.example", "tauri://localhost.example", "https://tauri.localhost/"]) {
      expect(isTrustedAnalyticsParent(origin, parent, parent, self)).toBe(false);
    }
    expect(isTrustedAnalyticsParent("tauri://localhost", {}, parent, self)).toBe(false);
    expect(isTrustedAnalyticsParent("tauri://localhost", self, self, self)).toBe(false);
  });
});
