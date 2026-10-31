import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_BRIDGE_URL, type AnalyticsInit } from "../../src/lib/analytics-protocol";
import { analyticsConfiguration, analyticsEventParameters, createGoogleAnalyticsTag } from "./analytics-tag";

const init: AnalyticsInit = {
  type: "rebasely:analytics:init", protocol: 1,
  generation: "099a2525-4c0c-41e6-9969-9ecf6d4e26c7",
  clientId: "245bbf45-cbda-49cd-b1d6-d580fe56a85e", sessionId: 1_700_000_000,
  platform: "windows", appVersion: "1.2.3",
};

function hostFixture() {
  const script = {
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    src: "", async: false, referrerPolicy: "", remove: vi.fn(),
  };
  const host = {
    document: { createElement: vi.fn(() => script), head: { appendChild: vi.fn() } },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
  };
  return { host: host as unknown as Window, script, globals: host as unknown as Record<string, unknown> };
}

describe("official Google tag adapter", () => {
  it("uses generic metadata, explicit app identity and no automatic page view or advertising", () => {
    expect(analyticsConfiguration(init)).toEqual({
      client_id: init.clientId, session_id: init.sessionId, send_page_view: false,
      page_title: "Rebasely desktop", page_location: ANALYTICS_BRIDGE_URL, page_referrer: "",
      ignore_referrer: true, allow_google_signals: false, allow_ad_personalization_signals: false,
      cookie_prefix: "rebasely_app", cookie_path: "/Rebasely/analytics/", cookie_expires: 0, cookie_update: false,
    });
    expect(analyticsEventParameters(init, {
      type: "event", generation: init.generation, event: "pane_view", pane: "git_history",
    }, "G-EXAMPLE42")).toEqual({
      send_to: "G-EXAMPLE42", client_id: init.clientId, session_id: init.sessionId,
      app_name: "Rebasely", app_version: "1.2.3", app_platform: "windows",
      page_title: "Rebasely desktop", page_location: ANALYTICS_BRIDGE_URL, page_referrer: "", pane: "git_history",
    });
  });

  it("does not create a remote script when deployment configuration is absent or malformed", () => {
    const { host } = hostFixture();
    for (const id of [undefined, "", "UA-1234", "G-EXAMPLE42?extra=1", "G-EXAMPLE42\n"]) {
      expect(() => createGoogleAnalyticsTag(host, id, init)).toThrow("Analytics is unavailable.");
    }
    expect(host.document.createElement).not.toHaveBeenCalled();
  });

  it("preserves the Arguments command protocol and disables before removing the script", async () => {
    const { host, script, globals } = hostFixture();
    const tag = createGoogleAnalyticsTag(host, "G-EXAMPLE42", init);
    const ready = tag.ready.catch(() => undefined);
    const layer = globals.dataLayer as IArguments[];
    expect(layer).toHaveLength(3);
    expect(layer.every((command) => Object.prototype.toString.call(command) === "[object Arguments]")).toBe(true);
    expect(Array.from(layer[0])).toEqual(["consent", "default", {
      ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
    }]);
    expect(script.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-EXAMPLE42");
    expect(script.referrerPolicy).toBe("no-referrer");
    script.remove.mockImplementation(() => {
      expect(globals["ga-disable-G-EXAMPLE42"]).toBe(true);
      expect(layer).toHaveLength(0);
    });
    tag.disable();
    tag.disable();
    tag.send({ type: "event", generation: init.generation, event: "app_open" });
    expect(script.remove).toHaveBeenCalledOnce();
    expect(layer).toHaveLength(0);
    expect(script.onload).toBeNull();
    expect(script.onerror).toBeNull();
    await ready;
  });

  it("includes only explicit foreground duration on engagement events", async () => {
    const { host, script, globals } = hostFixture();
    const tag = createGoogleAnalyticsTag(host, "G-EXAMPLE42", init);
    script.onload?.();
    await tag.ready;
    tag.send({ type: "event", generation: init.generation, event: "app_engagement", engagementTimeMsec: 1500 });
    const command = Array.from((globals.dataLayer as IArguments[])[3]);
    expect(command.slice(0, 2)).toEqual(["event", "app_engagement"]);
    expect(command[2]).toMatchObject({ engagement_time_msec: 1500 });
    expect(command[2]).not.toHaveProperty("generation");
    expect(command[2]).not.toHaveProperty("pane");
    tag.disable();
  });
});
