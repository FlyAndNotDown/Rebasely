import type { AppPrefs, PanelLayout, PanelLayouts } from "@/types/git";
import { pathsIgnoreCase } from "@/lib/format";

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
  editorId: "system",
  sidebarOrder: [...SIDEBAR_VIEWS],
  panelLayouts: { ...DEFAULT_PANEL_LAYOUTS },
  pullRebase: false,
  changesTree: false,
  diffSplit: false,
  diffIgnoreWhitespace: false,
  autoFetchMinutes: 60,
  fetchPrune: false,
  gitPath: "",
  extraGitPaths: [],
  p4Path: "",
  extraP4Paths: [],
  p4Port: "",
  p4User: "",
  p4Charset: "",
  p4RefreshMinutes: 60,
};

export const AUTO_FETCH_CHOICES = [0, 5, 15, 30, 60] as const;

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

export function isGitFileName(path: string): boolean {
  const base = path.trim().split(/[/\\]/).pop() ?? "";
  if (!base || base === "." || base === "..") return false;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.toLowerCase() === "git";
}

export function sameGitPath(left: string, right: string): boolean {
  return foldGitPath(left) === foldGitPath(right);
}

function foldGitPath(path: string): string {
  const slash = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return pathsIgnoreCase() ? slash.toLowerCase() : slash;
}

export function isP4FileName(path: string): boolean {
  const base = path.trim().split(/[/\\]/).pop() ?? "";
  if (!base || base === "." || base === "..") return false;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.toLowerCase() === "p4";
}

export function sameP4Path(left: string, right: string): boolean {
  return foldGitPath(left) === foldGitPath(right);
}

function normalizeP4Path(path: unknown): string {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  return isP4FileName(trimmed) ? trimmed : "";
}

function normalizeP4Paths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const next: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const path = raw.trim();
    if (!isP4FileName(path) || next.some((item) => sameP4Path(item, path))) continue;
    next.push(path);
  }
  return next;
}

function normalizeSetting(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\r\n]/g, "");
}

function normalizeGitPath(path: unknown): string {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  return isGitFileName(trimmed) ? trimmed : "";
}

function normalizeGitPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const next: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const path = raw.trim();
    if (!isGitFileName(path) || next.some((item) => sameGitPath(item, path))) continue;
    next.push(path);
  }
  return next;
}

function normalizeCharset(value: unknown): string {
  const text = normalizeSetting(value).toLowerCase();
  return ["utf8", "utf8-bom", "utf16", "utf16le", "utf16be", "utf32le", "utf32be"].includes(text)
    ? text
    : "";
}

export function normalizePrefs(prefs: Partial<AppPrefs> | null | undefined): AppPrefs {
  return {
    terminalId: prefs?.terminalId || "auto",
    editorId: !prefs?.editorId || prefs.editorId === "auto" ? "system" : prefs.editorId,
    sidebarOrder: normalizeSidebarOrder(prefs?.sidebarOrder),
    panelLayouts: normalizePanelLayouts(prefs?.panelLayouts),
    pullRebase: prefs?.pullRebase === true,
    changesTree: prefs?.changesTree === true,
    diffSplit: prefs?.diffSplit === true,
    diffIgnoreWhitespace: prefs?.diffIgnoreWhitespace === true,
    autoFetchMinutes:
      typeof prefs?.autoFetchMinutes === "number" && prefs.autoFetchMinutes >= 0
        ? Math.round(prefs.autoFetchMinutes)
        : defaultPrefs.autoFetchMinutes,
    fetchPrune: prefs?.fetchPrune === true,
    gitPath: normalizeGitPath(prefs?.gitPath),
    extraGitPaths: normalizeGitPaths(prefs?.extraGitPaths),
    p4Path: normalizeP4Path(prefs?.p4Path),
    extraP4Paths: normalizeP4Paths(prefs?.extraP4Paths),
    p4Port: normalizeSetting(prefs?.p4Port),
    p4User: normalizeSetting(prefs?.p4User),
    p4Charset: normalizeCharset(prefs?.p4Charset),
    p4RefreshMinutes:
      typeof prefs?.p4RefreshMinutes === "number" && prefs.p4RefreshMinutes >= 0
        ? Math.round(prefs.p4RefreshMinutes)
        : defaultPrefs.p4RefreshMinutes,
  };
}
