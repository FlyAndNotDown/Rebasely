export type FileKind =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typechange"
  | "copied";

export interface RepoInfo {
  path: string;
  name: string;
  currentBranch: string | null;
  headId: string | null;
  isDetached: boolean;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
}

export interface FileStatus {
  path: string;
  oldPath: string | null;
  kind: FileKind | string;
  staged: boolean;
}

export interface StatusSnapshot {
  staged: FileStatus[];
  unstaged: FileStatus[];
}

export interface CommitRef {
  name: string;
  kind: "head" | "branch" | "tag" | string;
}

export interface CommitSummary {
  id: string;
  shortId: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
  refs: CommitRef[];
  onCurrentBranch: boolean;
}

export interface DiffLine {
  kind: "add" | "delete" | "context" | "hunk" | "meta" | string;
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  truncated: boolean;
  lines: DiffLine[];
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  kind: FileKind | string;
  binary: boolean;
}

export interface CommitDetails {
  commit: CommitSummary;
  files: CommitFile[];
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface BranchList {
  current: string | null;
  isDetached: boolean;
  local: BranchInfo[];
  remote: BranchInfo[];
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface TerminalOption {
  id: string;
  name: string;
  available: boolean;
}

export type AvatarProvider = "dicebear";

export type PanelLayout = Record<string, number>;

export type PanelLayoutId = "historyShell" | "history" | "historyDetails" | "changes";

export interface PanelLayouts {
  historyShell: PanelLayout;
  history: PanelLayout;
  historyDetails: PanelLayout;
  changes: PanelLayout;
}

export interface AppPrefs {
  terminalId: string;
  avatarProvider: AvatarProvider;
  sidebarOrder: string[];
  panelLayouts: PanelLayouts;
}

export interface RemoteInfo {
  name: string;
  url: string | null;
  pushUrl: string | null;
}

export interface RemoteProbe {
  heads: number;
}

export interface StashInfo {
  index: number;
  message: string;
  id: string;
}

export interface WorkspaceSnapshot {
  repo: RepoInfo;
  status: StatusSnapshot;
  branches: BranchList;
  remotes: RemoteInfo[];
  stashes: StashInfo[];
  headCommit: CommitSummary | null;
}

export interface Activity {
  id: string;
  label: string;
  detail?: string;
  progress?: number;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: number;
}

export interface AppSession {
  openPaths: string[];
  active: string;
  historyRevs?: Record<string, string[]>;
  historyExpanded?: Record<string, string[]>;
}

export type Selection =
  | { type: "change"; path: string; staged: boolean }
  | { type: "commit"; id: string; path?: string };
