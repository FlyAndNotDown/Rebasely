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

export interface CommitSummary {
  id: string;
  shortId: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
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
}

export interface WorkspaceSnapshot {
  repo: RepoInfo;
  status: StatusSnapshot;
  branches: BranchList;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: number;
}

export type Selection =
  | { type: "change"; path: string; staged: boolean }
  | { type: "commit"; id: string; path?: string };
