import type { AppPrefs } from "@/types/git";

export const SIDEBAR_VIEWS = ["changes", "history", "stash"] as const;

export const defaultPrefs: AppPrefs = {
  terminalId: "auto",
  avatarProvider: "dicebear",
  sidebarOrder: [...SIDEBAR_VIEWS],
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

export function normalizePrefs(prefs: Partial<AppPrefs> | null | undefined): AppPrefs {
  return {
    terminalId: prefs?.terminalId || "auto",
    avatarProvider: "dicebear",
    sidebarOrder: normalizeSidebarOrder(prefs?.sidebarOrder),
  };
}
