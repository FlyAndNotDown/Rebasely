import type { AppPrefs } from "@/types/git";

export const defaultPrefs: AppPrefs = {
  terminalId: "auto",
  avatarProvider: "dicebear",
};

export function normalizePrefs(prefs: Partial<AppPrefs> | null | undefined): AppPrefs {
  return {
    terminalId: prefs?.terminalId || "auto",
    avatarProvider: "dicebear",
  };
}
