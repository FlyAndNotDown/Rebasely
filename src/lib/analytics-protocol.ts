export const ANALYTICS_BRIDGE_URL = "https://flyandnotdown.github.io/Rebasely/analytics/";

export const ANALYTICS_PANES = [
  "welcome", "git_changes", "git_history", "git_stash", "git_files",
  "p4_pending", "p4_files", "p4_history", "p4_depot",
] as const;

export type AnalyticsPane = typeof ANALYTICS_PANES[number];
export type AnalyticsPlatform = "windows" | "macos" | "linux" | "other";

export interface AnalyticsInit {
  type: "rebasely:analytics:init";
  protocol: 1;
  generation: string;
  clientId: string;
  sessionId: number;
  platform: AnalyticsPlatform;
  appVersion: string;
}

export type AnalyticsEvent = { type: "event"; generation: string } & (
  { event: "app_open" }
  | { event: "pane_view"; pane: AnalyticsPane }
  | { event: "app_engagement"; engagementTimeMsec: number }
);

export interface AnalyticsDisable { type: "disable"; generation: string }
export interface AnalyticsReply { type: "ready" | "disabled" | "error"; generation: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TRUSTED_ORIGINS = new Set([
  // MessageEvent uses the registered WebKit scheme's origin, unlike URL.origin.
  "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
  // Exact development origins support local QA. The bridge has no native IPC.
  "http://localhost:1420", "http://127.0.0.1:1420",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function isAnalyticsVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = VERSION.exec(value);
  return match !== null && (match[4]?.split(".").every((part) => !/^0\d+$/.test(part)) ?? true);
}

export function isTrustedAnalyticsParent(origin: string, source: unknown, parent: unknown, self: unknown) {
  return parent !== self && source === parent && TRUSTED_ORIGINS.has(origin);
}

export function isAnalyticsInit(value: unknown): value is AnalyticsInit {
  return record(value)
    && exactKeys(value, ["type", "protocol", "generation", "clientId", "sessionId", "platform", "appVersion"])
    && value.type === "rebasely:analytics:init" && value.protocol === 1
    && typeof value.generation === "string" && UUID.test(value.generation)
    && typeof value.clientId === "string" && UUID.test(value.clientId)
    && typeof value.sessionId === "number" && Number.isSafeInteger(value.sessionId) && value.sessionId > 0
    && ["windows", "macos", "linux", "other"].includes(value.platform as string)
    && isAnalyticsVersion(value.appVersion);
}

export function isAnalyticsEvent(value: unknown, generation: string): value is AnalyticsEvent {
  if (!record(value) || value.type !== "event" || value.generation !== generation) return false;
  if (value.event === "app_open") return exactKeys(value, ["type", "generation", "event"]);
  if (value.event === "pane_view") {
    return exactKeys(value, ["type", "generation", "event", "pane"])
      && ANALYTICS_PANES.includes(value.pane as AnalyticsPane);
  }
  return value.event === "app_engagement"
    && exactKeys(value, ["type", "generation", "event", "engagementTimeMsec"])
    && typeof value.engagementTimeMsec === "number" && Number.isInteger(value.engagementTimeMsec)
    && value.engagementTimeMsec >= 1 && value.engagementTimeMsec <= 60_000;
}

export function isAnalyticsDisable(value: unknown, generation: string): value is AnalyticsDisable {
  return record(value) && exactKeys(value, ["type", "generation"])
    && value.type === "disable" && value.generation === generation;
}

export function isAnalyticsReply(value: unknown, generation: string): value is AnalyticsReply {
  return record(value) && exactKeys(value, ["type", "generation"])
    && ["ready", "disabled", "error"].includes(value.type as string) && value.generation === generation;
}
