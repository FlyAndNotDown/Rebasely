import { ANALYTICS_BRIDGE_URL, type AnalyticsEvent, type AnalyticsInit } from "../../src/lib/analytics-protocol";
import type { AnalyticsTag } from "./analytics-bridge";

const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

export function analyticsConfiguration(init: AnalyticsInit) {
  return {
    client_id: init.clientId,
    session_id: init.sessionId,
    send_page_view: false,
    page_title: "Rebasely desktop",
    page_location: ANALYTICS_BRIDGE_URL,
    page_referrer: "",
    ignore_referrer: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_flags: "SameSite=None;Secure",
    cookie_prefix: "rebasely_app",
    cookie_path: "/Rebasely/analytics/",
    cookie_expires: 0,
    cookie_update: false,
  } as const;
}

export function analyticsEventParameters(init: AnalyticsInit, event: AnalyticsEvent, measurementId: string) {
  return {
    send_to: measurementId,
    client_id: init.clientId,
    session_id: init.sessionId,
    app_name: "Rebasely",
    app_version: init.appVersion,
    app_platform: init.platform,
    page_title: "Rebasely desktop",
    page_location: ANALYTICS_BRIDGE_URL,
    page_referrer: "",
    ...(event.event === "pane_view" ? { pane: event.pane } : {}),
    ...(event.event === "app_engagement" ? { engagement_time_msec: event.engagementTimeMsec } : {}),
  };
}

export function createGoogleAnalyticsTag(host: Window, measurementId: string | undefined, init: AnalyticsInit): AnalyticsTag {
  if (!measurementId || !MEASUREMENT_ID.test(measurementId)) throw new Error("Analytics is unavailable.");
  const globals = host as unknown as Record<string, unknown>;
  const disableKey = `ga-disable-${measurementId}`;
  const layer: unknown[] = [];
  let disabled = false;
  let timeout: number | undefined;
  let rejectLoad: ((error: Error) => void) | undefined;
  const script = host.document.createElement("script");
  globals[disableKey] = false;
  globals.dataLayer = layer;
  function gtag(..._parameters: unknown[]) {
    // Google tag commands require the canonical Arguments object, not an Array.
    // eslint-disable-next-line prefer-rest-params -- Preserve the official gtag.js command protocol.
    if (!disabled) layer.push(arguments);
  }
  globals.gtag = gtag;
  // Cross-site cookie attributes support the HTTPS bridge iframe, but browser
  // privacy settings can still block third-party cookies.
  // The dedicated GA stream must also have Enhanced Measurement disabled.
  gtag("consent", "default", {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied",
    analytics_storage: "granted",
  });
  gtag("js", new Date());
  gtag("config", measurementId, analyticsConfiguration(init));
  const ready = new Promise<void>((resolve, reject) => {
    rejectLoad = reject;
    script.onload = () => {
      if (timeout !== undefined) host.clearTimeout(timeout);
      if (!disabled) resolve();
    };
    script.onerror = () => reject(new Error("Analytics is unavailable."));
    timeout = host.setTimeout(() => reject(new Error("Analytics is unavailable.")), 10_000);
  });
  script.async = true;
  script.referrerPolicy = "no-referrer";
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  host.document.head.appendChild(script);
  return {
    ready,
    send(event) {
      if (!disabled) gtag("event", event.event, analyticsEventParameters(init, event, measurementId));
    },
    disable() {
      if (disabled) return;
      disabled = true;
      // Google checks this flag before cookies or collection, including unload.
      globals[disableKey] = true;
      layer.length = 0;
      if (timeout !== undefined) host.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      script.remove();
      rejectLoad?.(new Error("Analytics is disabled."));
    },
  };
}
