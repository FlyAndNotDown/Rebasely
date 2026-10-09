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
  /** The message git prepared for the commit that finishes this step. */
  message: string | null;
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
  /** The file's name at this commit; only set by per-file history. */
  path?: string;
}

export interface DiffLine {
  kind: "add" | "delete" | "context" | "hunk" | "meta" | string;
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

/** A changed line picked for staging: an addition by its new number, a removal by its old one. */
export interface LineRef {
  old: number | null;
  new: number | null;
}

export type LineAction = "stage" | "unstage" | "discard";

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  truncated: boolean;
  lines: DiffLine[];
}

/** Where the two sides of a file diff come from; mirrors `FileSource` in Rust. */
export type FileSource =
  | { kind: "workdir"; path: string; staged: boolean }
  | { kind: "commit"; oid: string; path: string; oldPath: string | null }
  | { kind: "compare"; base: string; head: string; path: string; oldPath: string | null }
  | { kind: "stash"; oid: string; path: string };

export interface ImageSide {
  dataUrl: string | null;
  size: number;
  /** The stored content is a Git LFS pointer, not the image. */
  lfs: boolean;
  tooLarge: boolean;
}

export interface ImagePair {
  before: ImageSide | null;
  after: ImageSide | null;
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

export interface ReflogEntry {
  /** `HEAD@{n}` */
  selector: string;
  id: string;
  shortId: string;
  /** What moved HEAD, e.g. `commit: Fix the build`. */
  message: string;
  timestamp: number;
  /** The subject of the commit HEAD moved to. */
  summary: string;
}

export interface UndoneCommit {
  snapshot: WorkspaceSnapshot;
  message: string;
}

export interface ToolConfig {
  diffTool: string;
  mergeTool: string;
}

export interface AppPrefs {
  terminalId: string;
  /** "auto", "system", or an id from `list_editors`. */
  editorId: string;
  sidebarOrder: string[];
  panelLayouts: PanelLayouts;
  pullRebase: boolean;
  /** Group changed files by folder instead of listing them flat. */
  changesTree: boolean;
  /** Show diffs side by side. */
  diffSplit: boolean;
  /** Hide whitespace-only changes in diffs; line staging is off while set. */
  diffIgnoreWhitespace: boolean;
  /** Minutes between background fetches of the open repository; 0 turns them off. */
  autoFetchMinutes: number;
  /** Remove remote-tracking branches that are gone from the remote when fetching. */
  fetchPrune: boolean;
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
  /** The activity id was handed to a git process that `cancel_activity` can stop. */
  cancellable?: boolean;
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
