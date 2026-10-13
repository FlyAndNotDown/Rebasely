import { pathSegments, sameRepoPath } from "@/lib/format";
import type {
  CommitDetails,
  CommitSummary,
  FileDiff,
  RevisionComparison,
  Selection,
  StashDetails,
  WorkspaceSnapshot,
} from "@/types/git";

export type View = "changes" | "history" | "stash" | "files";
export type ResetMode = "soft" | "mixed" | "hard" | "merge" | "keep";
export const WELCOME_TAB_ID = "welcome";
export const COMMIT_PAGE = 80;

export function defaultFetchRemote(snapshot: WorkspaceSnapshot | null | undefined) {
  const names = snapshot?.remotes.map((remote) => remote.name) ?? [];
  const upstream = snapshot?.repo.upstream;
  if (upstream) {
    const match = names
      .filter((name) => upstream === name || upstream.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (match) return match;
    const slash = upstream.indexOf("/");
    if (slash > 0) return upstream.slice(0, slash);
  }
  return names.includes("origin") ? "origin" : undefined;
}

export function primaryRemote(snapshot: WorkspaceSnapshot | null | undefined) {
  const names = snapshot?.remotes.map((remote) => remote.name) ?? [];
  return names.find((name) => name === "origin") ?? names[0];
}

export type PublishPrompt = {
  branch: string;
  remote: string;
};

export type WelcomeTab = { id: typeof WELCOME_TAB_ID; kind: "welcome" };
export type RepoTab = {
  id: string;
  kind: "repo";
  path: string;
  name: string;
  branch: string | null;
  isDetached: boolean;
};
export type AppTab = WelcomeTab | RepoTab;

export type ChangeSelection = Extract<Selection, { type: "change" }>;
export type HistorySelection = Extract<Selection, { type: "commit" }>;
export type StashSelection = {
  type: "stash";
  id: string;
  index: number;
  path?: string;
};

/** Text to put in the commit box, e.g. after undoing a commit. */
export type CommitDraft = {
  text: string;
  nonce: number;
};

/** A request for the Files view to open a file; `nonce` makes repeats count. */
export type FileFocus = {
  path: string;
  mode: "browse" | "history";
  nonce: number;
};

export interface RepoSession {
  path: string;
  snapshot: WorkspaceSnapshot | null;
  commits: CommitSummary[];
  commitsLoaded: boolean;
  commitsHasMore: boolean;
  commitsLoading: boolean;
  historyRevs: string[];
  historyExpanded: string[] | null;
  view: View;
  changeSelection: ChangeSelection | null;
  historySelection: HistorySelection | null;
  changeDiff: FileDiff | null;
  historyDiff: FileDiff | null;
  commitDetails: CommitDetails | null;
  comparison: RevisionComparison | null;
  stashSelection: StashSelection | null;
  stashDetails: StashDetails | null;
  stashDiff: FileDiff | null;
  fileFocus: FileFocus | null;
  commitDraft: CommitDraft | null;
}

export function repoTabId(path: string): string {
  return `repo:${path}`;
}

export function emptySession(
  path: string,
  historyRevs: string[] = [],
  historyExpanded: string[] | null = null,
): RepoSession {
  return {
    path,
    snapshot: null,
    commits: [],
    commitsLoaded: false,
    commitsHasMore: true,
    commitsLoading: false,
    historyRevs,
    historyExpanded,
    view: "changes",
    changeSelection: null,
    historySelection: null,
    changeDiff: null,
    historyDiff: null,
    commitDetails: null,
    comparison: null,
    stashSelection: null,
    stashDetails: null,
    stashDiff: null,
    fileFocus: null,
    commitDraft: null,
  };
}

export function lookupHistoryRevs(map: Record<string, string[]>, path: string): string[] {
  return lookupPathList(map, path) ?? [];
}

export function lookupPathList(map: Record<string, string[]>, path: string): string[] | null {
  if (Object.prototype.hasOwnProperty.call(map, path)) return map[path] ?? [];
  const key = Object.keys(map).find((item) => sameRepoPath(item, path));
  return key ? (map[key] ?? []) : null;
}

export function repoNameFromPath(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] || path;
}

export function tabFromPath(path: string, name?: string): RepoTab {
  return {
    id: repoTabId(path),
    kind: "repo",
    path,
    name: name || repoNameFromPath(path),
    branch: null,
    isDetached: false,
  };
}

export function tabFromSnapshot(snapshot: WorkspaceSnapshot): RepoTab {
  return {
    id: repoTabId(snapshot.repo.path),
    kind: "repo",
    path: snapshot.repo.path,
    name: snapshot.repo.name,
    branch: snapshot.repo.currentBranch,
    isDetached: snapshot.repo.isDetached,
  };
}

export function findRepoTab(tabs: AppTab[], path: string): RepoTab | undefined {
  return tabs.find(
    (tab): tab is RepoTab => tab.kind === "repo" && sameRepoPath(tab.path, path),
  );
}

/** Appends the welcome tab when it is closed. Returns the same array if it is already open. */
export function insertWelcomeTab(tabs: AppTab[]): AppTab[] {
  if (tabs.some((tab) => tab.kind === "welcome")) return tabs;
  return [...tabs, { id: WELCOME_TAB_ID, kind: "welcome" }];
}

/**
 * Puts an opened repository on the tab strip.
 * When `replaceWelcome` is set, the welcome tab becomes that repository.
 * A repository that is already open stays put; the welcome tab is removed instead of duplicated.
 */
export function placeOpenedRepoTab(tabs: AppTab[], tab: RepoTab, replaceWelcome: boolean): AppTab[] {
  const welcomeIndex = tabs.findIndex((item) => item.kind === "welcome");
  const existingIndex = tabs.findIndex((item) => item.id === tab.id);
  if (replaceWelcome && welcomeIndex >= 0) {
    if (existingIndex >= 0) {
      const next = tabs.filter((item) => item.kind !== "welcome");
      return next.length === tabs.length ? tabs : next;
    }
    const next = tabs.slice();
    next[welcomeIndex] = tab;
    return next;
  }
  if (existingIndex >= 0) return tabs;
  return [...tabs, tab];
}

export function reorderAppTabs(
  tabs: AppTab[],
  fromId: string,
  toId: string,
  place: "before" | "after",
): AppTab[] {
  const from = tabs.findIndex((tab) => tab.id === fromId);
  if (from < 0) return tabs;
  const next = [...tabs];
  const [item] = next.splice(from, 1);
  let insert = next.findIndex((tab) => tab.id === toId);
  if (insert < 0) return tabs;
  if (place === "after") insert += 1;
  next.splice(insert, 0, item);
  const unchanged =
    next.length === tabs.length && next.every((tab, index) => tab.id === tabs[index].id);
  return unchanged ? tabs : next;
}
