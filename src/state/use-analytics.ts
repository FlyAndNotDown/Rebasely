import { useEffect, useRef, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { version } from "../../package.json";
import { analyticsInstallId, analyticsSessionAllowed, ANALYTICS_PULSE_MS, createAnalyticsController, registerAnalyticsStop, subscribeAnalyticsSession } from "@/lib/analytics";
import { createAnalyticsFrame } from "@/lib/analytics-frame";
import type { AnalyticsPane } from "@/lib/analytics-protocol";
import { desktopPlatform } from "@/lib/desktop-platform";
import { useGitPick } from "./git-context";
import { useP4View } from "./p4-context";

export function useAnalyticsSessionAllowed() {
  return useSyncExternalStore(subscribeAnalyticsSession, analyticsSessionAllowed, analyticsSessionAllowed);
}

export function useAnalytics() {
  const { prefs, prefsReady, activeTab, view } = useGitPick(["prefs", "prefsReady", "activeTab", "view"]);
  const p4View = useP4View();
  const allowed = useAnalyticsSessionAllowed();
  const controller = useRef<ReturnType<typeof createAnalyticsController> | null>(null);
  const pane: AnalyticsPane = activeTab.kind !== "repo" ? "welcome" : activeTab.vcs === "perforce"
    ? p4View === "pending" ? "p4_pending" : p4View === "submitted" ? "p4_history" : "p4_files"
    : view === "history" ? "git_history" : view === "stash" ? "git_stash" : view === "files" ? "git_files" : "git_changes";

  useEffect(() => {
    // A browser preview must never count as an installed application.
    if (!isTauri()) return;
    const current = createAnalyticsController({
      installId: () => analyticsInstallId(localStorage, () => crypto.randomUUID()),
      randomUUID: () => crypto.randomUUID(),
      now: () => performance.now(),
      sessionId: () => Math.floor(Date.now() / 1_000),
      platform: desktopPlatform(),
      appVersion: version,
      createBridge: createAnalyticsFrame,
    });
    controller.current = current;
    const foreground = () => current.setForeground(!document.hidden && document.hasFocus());
    const stop = registerAnalyticsStop(() => current.stop());
    foreground();
    window.addEventListener("focus", foreground);
    window.addEventListener("blur", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      window.removeEventListener("blur", foreground);
      document.removeEventListener("visibilitychange", foreground);
      stop();
      current.stop();
      controller.current = null;
    };
  }, []);

  useEffect(() => { controller.current?.setPane(pane); }, [pane]);
  useEffect(() => { controller.current?.configure(prefsReady, prefs.analyticsEnabled && allowed); }, [prefsReady, prefs.analyticsEnabled, allowed]);
  useEffect(() => {
    if (!prefsReady || !prefs.analyticsEnabled || !allowed || !isTauri()) return;
    const timer = window.setInterval(() => controller.current?.pulse(), ANALYTICS_PULSE_MS);
    return () => { window.clearInterval(timer); };
  }, [prefsReady, prefs.analyticsEnabled, allowed]);
}
