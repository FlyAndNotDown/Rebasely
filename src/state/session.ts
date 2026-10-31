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
export type VcsKind = "git" | "perforce";
export type RepoTab = {
  id: string;
  kind: "repo";
  vcs: VcsKind;
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

export function asVcs(value: string | null | undefined): VcsKind {
  return value === "perforce" ? "perforce" : "git";
}

export function repoTabId(path: string, vcs: VcsKind = "git"): string {
  return vcs === "perforce" ? `p4:${path}` : `repo:${path}`;
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

export function tabFromPath(path: string, name?: string, vcs: VcsKind = "git"): RepoTab {
  return {
    id: repoTabId(path, vcs),
    kind: "repo",
    vcs,
    path,
    name: name || repoNameFromPath(path),
    branch: null,
    isDetached: false,
  };
}

export function tabFromSnapshot(snapshot: WorkspaceSnapshot): RepoTab {
  return {
    id: repoTabId(snapshot.repo.path, "git"),
    kind: "repo",
    vcs: "git",
    path: snapshot.repo.path,
    name: snapshot.repo.name,
    branch: snapshot.repo.currentBranch,
    isDetached: snapshot.repo.isDetached,
  };
}

export function findRepoTab(tabs: AppTab[], path: string, vcs?: VcsKind): RepoTab | undefined {
  return tabs.find(
    (tab): tab is RepoTab =>
      tab.kind === "repo" && sameRepoPath(tab.path, path) && (vcs === undefined || tab.vcs === vcs),
  );
}

/** Adds a repository tab. The welcome page is not a tab, so any welcome entry is dropped. */
export function placeOpenedRepoTab(tabs: AppTab[], tab: RepoTab): AppTab[] {
  const repos = tabs.filter((item): item is RepoTab => item.kind === "repo");
  if (repos.some((item) => item.id === tab.id)) {
    return repos.length === tabs.length ? tabs : repos;
  }
  return [...repos, tab];
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
