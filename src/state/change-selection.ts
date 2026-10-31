import type { WorkspaceSnapshot } from "@/types/git";
import type { ChangeSelection } from "./session";

/** Keep a selected file only in a scope that still exists after a mutation. */
export function reconcileChangeSelection(selection: ChangeSelection | null, status: WorkspaceSnapshot["status"]): ChangeSelection | null {
  if (!selection) return null;
  const same = selection.staged ? status.staged : status.unstaged;
  if (same.some((file) => file.path === selection.path)) return selection;
  const other = selection.staged ? status.unstaged : status.staged;
  return other.some((file) => file.path === selection.path) ? { ...selection, staged: !selection.staged } : null;
}
