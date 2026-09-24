import { normalizeAvatarProvider } from "@/lib/avatar";
import type { AppPrefs, PanelLayout, PanelLayouts } from "@/types/git";

export const SIDEBAR_VIEWS = ["changes", "history", "stash", "files"] as const;

export const DEFAULT_PANEL_LAYOUTS: PanelLayouts = {
  historyShell: { "history-branches": 15, "history-main": 85 },
  history: { "history-commits": 67, "history-details": 33 },
  historyDetails: { "history-files": 34, "history-diff": 66 },
  changes: { "changes-files": 36, "changes-diff": 64 },
  stash: { "stash-side": 30, "stash-main": 70 },
  stashDetails: { "stash-files": 28, "stash-diff": 72 },
  files: { "files-tree": 22, "files-main": 78 },
  fileHistory: { "file-commits": 42, "file-diff": 58 },
};

export const defaultPrefs: AppPrefs = {
  terminalId: "auto",
  avatarProvider: "initials",
  sidebarOrder: [...SIDEBAR_VIEWS],
  panelLayouts: { ...DEFAULT_PANEL_LAYOUTS },
  pullRebase: false,
};

export function normalizeSidebarOrder(order?: string[] | null): string[] {
  const allowed = new Set<string>(SIDEBAR_VIEWS);
  const next: string[] = [];
  for (const item of order ?? []) {
    if (allowed.has(item) && !next.includes(item)) next.push(item);
  }
  for (const item of SIDEBAR_VIEWS) {
    if (!next.includes(item)) next.push(item);
  }
  return next;
}

export function compactLayout(layout: PanelLayout): PanelLayout {
  const next: PanelLayout = {};
  for (const [key, value] of Object.entries(layout)) {
    next[key] = Math.round(value * 100) / 100;
  }
  return next;
}

export function sameLayout(left?: PanelLayout | null, right?: PanelLayout | null): boolean {
  const a = compactLayout(left ?? {});
  const b = compactLayout(right ?? {});
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function normalizeLayout(value: PanelLayout | null | undefined, fallback: PanelLayout): PanelLayout {
  if (!value) return { ...fallback };
  const next: PanelLayout = {};
  let total = 0;
  for (const key of Object.keys(fallback)) {
    const n = Number(value[key]);
    if (!Number.isFinite(n) || n <= 0) return { ...fallback };
    next[key] = n;
    total += n;
  }
  if (Math.abs(total - 100) > 8) return { ...fallback };
  return compactLayout(next);
}

export function normalizeHistoryShell(value?: PanelLayout | null): PanelLayout {
  const fallback = DEFAULT_PANEL_LAYOUTS.historyShell;
  const raw = normalizeLayout(value, fallback);
  const branches = raw["history-branches"];
  if (branches < 12 || branches > 32) return { ...fallback };
  return {
    "history-branches": branches,
    "history-main": Math.round((100 - branches) * 100) / 100,
  };
}

export function normalizePanelLayouts(value?: Partial<PanelLayouts> | null): PanelLayouts {
  return {
    historyShell: normalizeHistoryShell(value?.historyShell),
    history: normalizeLayout(value?.history, DEFAULT_PANEL_LAYOUTS.history),
    historyDetails: normalizeLayout(value?.historyDetails, DEFAULT_PANEL_LAYOUTS.historyDetails),
    changes: normalizeLayout(value?.changes, DEFAULT_PANEL_LAYOUTS.changes),
    stash: normalizeLayout(value?.stash, DEFAULT_PANEL_LAYOUTS.stash),
    stashDetails: normalizeLayout(value?.stashDetails, DEFAULT_PANEL_LAYOUTS.stashDetails),
    files: normalizeLayout(value?.files, DEFAULT_PANEL_LAYOUTS.files),
    fileHistory: normalizeLayout(value?.fileHistory, DEFAULT_PANEL_LAYOUTS.fileHistory),
  };
}

export function normalizePrefs(prefs: Partial<AppPrefs> | null | undefined): AppPrefs {
  return {
    terminalId: prefs?.terminalId || "auto",
    avatarProvider: normalizeAvatarProvider(prefs?.avatarProvider),
    sidebarOrder: normalizeSidebarOrder(prefs?.sidebarOrder),
    panelLayouts: normalizePanelLayouts(prefs?.panelLayouts),
    pullRebase: prefs?.pullRebase === true,
  };
}
