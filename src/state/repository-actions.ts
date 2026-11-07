import { t } from "@/i18n";
/** Delayed notifications keep the repository that created them. */
export function repositoryUndoAction(tabId: string, undo: (tabId: string) => Promise<boolean>) {
  return { label: t("operations.undo"), onClick: () => { void undo(tabId); } };
}

/** Git date-order keeps children before parents, even when author timestamps tie or move backwards. */
export function orderReplayCommits<T>(commits: readonly T[], operation: "revert" | "cherry-pick"): T[] {
  return operation === "cherry-pick" ? [...commits].reverse() : [...commits];
}

/** A tab switch must not redirect the remaining commits of an ordered batch. */
export async function replayCommitBatch(
  tabId: string,
  commits: readonly { id: string }[],
  replay: (oid: string, tabId: string) => Promise<boolean>,
) {
  for (const commit of commits) {
    if (!await replay(commit.id, tabId)) return false;
  }
  return true;
}
