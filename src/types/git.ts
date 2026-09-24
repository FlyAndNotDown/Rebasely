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
  rebase: RebaseProgress | null;
  operation: GitOperation | null;
}

export interface GitOperation {
  kind: "merge" | "rebase" | "cherry-pick" | "revert" | string;
  headName: string | null;
  onto: string | null;
  step: number | null;
  total: number | null;
}

export interface RebaseProgress {
  onto: string | null;
  headName: string | null;
  step: number | null;
  total: number | null;
}

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface RebaseCommit {
  id: string;
  shortId: string;
  summary: string;
}

export interface RebaseStep {
  id: string;
  action: RebaseAction;
  message: string;
}

export interface ConflictView {
  path: string;
  binary: boolean;
  text: string;
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
  onTrackingBranch: boolean;
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

export interface CompareRevision {
  rev: string;
  label: string;
}

export interface RevisionComparison {
  base: CompareRevision;
  head: CompareRevision;
  files: CommitFile[] | null;
  path: string | null;
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface TagInfo {
  name: string;
}

export interface BranchList {
  current: string | null;
  isDetached: boolean;
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: TagInfo[];
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

export type PanelLayoutId =
  | "historyShell"
  | "history"
  | "historyDetails"
  | "changes"
  | "stash"
  | "stashDetails"
  | "files"
  | "fileHistory";

export interface PanelLayouts {
  historyShell: PanelLayout;
  history: PanelLayout;
  historyDetails: PanelLayout;
  changes: PanelLayout;
  stash: PanelLayout;
  stashDetails: PanelLayout;
  files: PanelLayout;
  fileHistory: PanelLayout;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface FileText {
  binary: boolean;
  text: string;
}

export interface BlameHunk {
  start: number;
  count: number;
  commitId: string;
  author: string;
  time: number;
}

export interface AppPrefs {
  terminalId: string;
  avatarProvider: AvatarProvider;
  sidebarOrder: string[];
  panelLayouts: PanelLayouts;
  pullRebase: boolean;
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

export interface StashDetails {
  id: string;
  message: string;
  files: CommitFile[];
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
