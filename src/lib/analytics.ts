import type { AnalyticsEvent, AnalyticsInit, AnalyticsPane, AnalyticsPlatform } from "./analytics-protocol";

const INSTALL_ID_KEY = "rebasely.analytics.install-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING_EVENTS = 16;
export const ANALYTICS_PULSE_MS = 30_000;

export function analyticsInstallId(storage: Pick<Storage, "getItem" | "setItem">, randomUUID: () => string): string {
  try {
    const saved = storage.getItem(INSTALL_ID_KEY);
    if (saved && UUID.test(saved)) return saved;
  } catch {
    // Storage can be unavailable; never substitute a machine or account ID.
  }
  const id = randomUUID();
  if (!UUID.test(id)) throw new Error("Random installation ID is unavailable.");
  try { storage.setItem(INSTALL_ID_KEY, id); } catch { /* Keep an ephemeral ID. */ }
  return id;
}

export interface AnalyticsBridge {
  send(event: AnalyticsEvent): void;
  disable(): void;
}

interface AnalyticsOptions {
  installId: () => string;
  randomUUID: () => string;
  now: () => number;
  sessionId: () => number;
  platform: AnalyticsPlatform;
  appVersion: string;
  createBridge: (init: AnalyticsInit, callbacks: { ready: () => void; error: () => void }) => AnalyticsBridge;
}

export function createAnalyticsController(options: AnalyticsOptions) {
  let enabled = false;
  let bridge: AnalyticsBridge | null = null;
  let generation: string | null = null;
  let ready = false;
  let pending: AnalyticsEvent[] = [];
  let foreground = false;
  let startedAt: number | null = null;
  let pane: AnalyticsPane = "welcome";
  let sentPane: AnalyticsPane | null = null;
  const sessionId = options.sessionId();

  function send(event: AnalyticsEvent) {
    if (!enabled || !generation || event.generation !== generation || !bridge) return;
    if (ready) bridge.send(event);
    else if (pending.length < MAX_PENDING_EVENTS) pending.push(event);
  }

  function sendPane() {
    if (!foreground || !generation || sentPane === pane) return;
    send({ type: "event", generation, event: "pane_view", pane });
    sentPane = pane;
  }

  function flushEngagement() {
    if (startedAt === null) return;
    const now = options.now();
    const elapsed = Math.min(60_000, Math.max(0, Math.floor(now - startedAt)));
    startedAt = foreground && enabled ? now : null;
    if (elapsed > 0 && generation) send({ type: "event", generation, event: "app_engagement", engagementTimeMsec: elapsed });
  }

  function stop() {
    // Invalidate first: late frame readiness must never drain an old queue.
    generation = null;
    ready = false;
    pending = [];
    startedAt = null;
    sentPane = null;
    const previous = bridge;
    bridge = null;
    previous?.disable();
  }

  return {
    configure(preferencesReady: boolean, analyticsEnabled: boolean) {
      const next = preferencesReady && analyticsEnabled;
      if (next === enabled) return;
      enabled = next;
      if (!enabled) { stop(); return; }
      try {
        const current = options.randomUUID();
        generation = current;
        const init: AnalyticsInit = {
          type: "rebasely:analytics:init", protocol: 1, generation: current,
          clientId: options.installId(), sessionId, platform: options.platform, appVersion: options.appVersion,
        };
        bridge = options.createBridge(init, {
          ready() {
            if (!enabled || generation !== current || !bridge) return;
            ready = true;
            const queued = pending;
            pending = [];
            for (const event of queued) send(event);
          },
          error() { if (generation === current) stop(); },
        });
        send({ type: "event", generation: current, event: "app_open" });
        startedAt = foreground ? options.now() : null;
        sendPane();
      } catch {
        stop();
      }
    },
    setPane(next: AnalyticsPane) {
      if (pane === next) return;
      flushEngagement();
      pane = next;
      sendPane();
    },
    setForeground(next: boolean) {
      if (foreground === next) return;
      if (foreground) flushEngagement();
      foreground = next;
      startedAt = foreground && enabled ? options.now() : null;
      if (foreground) sendPane();
    },
    pulse: flushEngagement,
    stop() { enabled = false; stop(); },
  };
}

// A failed preference save must not silently resume analytics in this session.
let sessionAllowed = true;
const sessionListeners = new Set<() => void>();
const stopListeners = new Set<() => void>();
export const analyticsSessionAllowed = () => sessionAllowed;
export function subscribeAnalyticsSession(listener: () => void) {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}
export function registerAnalyticsStop(stop: () => void) {
  stopListeners.add(stop);
  return () => { stopListeners.delete(stop); };
}
export function setAnalyticsSessionAllowed(allowed: boolean) {
  sessionAllowed = allowed;
  if (!allowed) for (const stop of stopListeners) stop();
  for (const listener of sessionListeners) listener();
}
