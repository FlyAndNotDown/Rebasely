import { ANALYTICS_BRIDGE_URL, type AnalyticsEvent, type AnalyticsInit, type AnalyticsPane } from "../../src/lib/analytics-protocol";
import type { AnalyticsTag } from "./analytics-bridge";
import { createGoogleTag } from "./google-tag";

export const DESKTOP_ANALYTICS_NAME = "RebaseRavenApp";
const SCREEN_NAMES = {
  welcome: "Welcome",
  git_changes: "Git changes",
  git_history: "Git history",
  git_stash: "Git stashes",
  git_files: "Git files",
  p4_pending: "Perforce pending changes",
  p4_files: "Perforce files",
  p4_history: "Perforce history",
  p4_depot: "Perforce depot",
} satisfies Record<AnalyticsPane, string>;

export function analyticsConfiguration(init: AnalyticsInit) {
  return {
    client_id: init.clientId,
    session_id: init.sessionId,
    send_page_view: false,
    app_name: DESKTOP_ANALYTICS_NAME,
    app_version: init.appVersion,
    app_platform: init.platform,
    content_group: "Desktop application",
    page_title: SCREEN_NAMES.welcome,
    page_location: ANALYTICS_BRIDGE_URL,
    page_referrer: "",
    ignore_referrer: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_flags: "SameSite=None;Secure",
    cookie_prefix: "rebaseraven_app",
    cookie_domain: "none",
    cookie_path: new URL(ANALYTICS_BRIDGE_URL).pathname,
    cookie_expires: 0,
    cookie_update: false,
  } as const;
}

export function analyticsEventParameters(init: AnalyticsInit, event: AnalyticsEvent, measurementId: string, currentPane: AnalyticsPane = "welcome") {
  const pane = event.event === "pane_view" ? event.pane : currentPane;
  return {
    send_to: measurementId,
    client_id: init.clientId,
    session_id: init.sessionId,
    app_name: DESKTOP_ANALYTICS_NAME,
    app_version: init.appVersion,
    app_platform: init.platform,
    content_group: "Desktop application",
    screen_name: SCREEN_NAMES[pane],
    screen_class: pane,
    pane,
    version_control: pane.startsWith("git_") ? "git" : pane.startsWith("p4_") ? "perforce" : "none",
    // GA4 uses the web title in its combined Pages and screens report.
    page_title: SCREEN_NAMES[pane],
    page_location: ANALYTICS_BRIDGE_URL,
    page_referrer: "",
    ...(event.event === "app_engagement" ? {
      engagement_time_msec: event.engagementTimeMsec,
      foreground_time_sec: event.engagementTimeMsec / 1_000,
    } : {}),
  };
}

export function createGoogleAnalyticsTag(host: Window, measurementId: string | undefined, init: AnalyticsInit): AnalyticsTag {
  const tag = createGoogleTag(host, measurementId, analyticsConfiguration(init));
  let pane: AnalyticsPane = "welcome";
  return {
    ready: tag.ready,
    send(event) {
      if (event.event === "pane_view") pane = event.pane;
      tag.send(event.event === "pane_view" ? "screen_view" : event.event, analyticsEventParameters(init, event, measurementId!, pane));
    },
    disable: tag.disable,
  };
}
