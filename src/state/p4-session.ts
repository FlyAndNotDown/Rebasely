import type { FileDiff } from "@/types/git";
import type { P4Changelist, P4Connection, P4File } from "@/types/p4";
import { sameRepoPath } from "@/lib/format";

export type P4View = "pending" | "submitted" | "workspace";

export interface P4Session {
  tabId: string;
  connection: P4Connection;
  pending: P4Changelist[];
  selectedChange: string;
  selectedFile: string | null;
  selectedShelved: boolean;
  description: string;
  diff: FileDiff | null;
  diffFor: string;
  submitted: P4Changelist[];
  submittedHasMore: boolean;
  selectedSubmitted: string | null;
  submittedDetail: P4Changelist | null;
  submittedDiffs: FileDiff[];
  submittedUser: string;
  submittedClient: string;
  view: P4View;
}

export function sameP4Connection(left: P4Connection, right: P4Connection) {
  return sameRepoPath(left.root, right.root) && left.port === right.port && left.user === right.user &&
    left.client === right.client && left.charset === right.charset && left.stream === right.stream;
}

export function updateP4Session(
  sessions: Map<string, P4Session>,
  tabId: string,
  update: (current: P4Session) => P4Session,
) {
  const current = sessions.get(tabId);
  if (!current) return null;
  const next = update(current);
  sessions.set(tabId, next);
  return next;
}

export function refreshPendingSession(
  current: P4Session,
  pending: P4Changelist[],
  selectId?: string,
  selectionAtStart = current.selectedChange,
): P4Session {
  const preferred = current.selectedChange === selectionAtStart ? selectId : undefined;
  const selected = preferred && pending.some((change) => change.id === preferred)
    ? preferred
    : pending.some((change) => change.id === current.selectedChange)
      ? current.selectedChange
      : defaultChange(pending);
  const change = pending.find((item) => item.id === selected);
  const shown = shownFile(change?.files ?? [], {
    path: current.selectedFile,
    shelved: current.selectedShelved,
  });
  const previousDescription = current.pending.find((item) => item.id === current.selectedChange)?.description ?? "";
  const edited = current.description !== previousDescription;
  const sameSelection = selected === current.selectedChange &&
    shown.path === current.selectedFile && shown.shelved === current.selectedShelved;
  return {
    ...current,
    pending,
    selectedChange: selected,
    selectedFile: shown.path,
    selectedShelved: shown.shelved,
    description: selected === current.selectedChange && edited ? current.description : change?.description ?? "",
    diff: sameSelection ? current.diff : null,
    diffFor: "",
  };
}

export function fileKey(change: string, file: string | null, shelved: boolean) {
  return `${change}\n${file ?? ""}\n${shelved ? "shelf" : "open"}`;
}

export function shownFile(files: P4File[], preferred?: { path: string | null; shelved: boolean }) {
  if (
    preferred?.path &&
    files.some((file) => file.depotPath === preferred.path && file.shelved === preferred.shelved)
  ) {
    return { path: preferred.path, shelved: preferred.shelved };
  }
  const opened = files.find((file) => !file.shelved);
  if (opened) return { path: opened.depotPath, shelved: false };
  const shelf = files.find((file) => file.shelved);
  if (shelf) return { path: shelf.depotPath, shelved: true };
  return { path: null, shelved: false };
}

export function defaultChange(pending: P4Changelist[]) {
  return pending.find((change) => change.id === "default")?.id ?? pending[0]?.id ?? "default";
}
