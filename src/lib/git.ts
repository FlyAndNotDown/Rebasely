import { invoke } from "@tauri-apps/api/core";
import type {
  AppPrefs,
  AppSession,
  BranchList,
  CommitDetails,
  CommitSummary,
  FileDiff,
  GitIdentity,
  RecentRepo,
  TerminalOption,
  WorkspaceSnapshot,
} from "@/types/git";

export function emptyBinaryDiff(path: string, oldPath: string | null = null): FileDiff {
  return {
    path,
    oldPath,
    binary: true,
    truncated: false,
    lines: [],
  };
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const gitApi = {
  listRecents: () => invoke<RecentRepo[]>("list_recents"),
  forgetRecent: (path: string) => invoke<RecentRepo[]>("forget_recent", { path }),
  loadSession: () => invoke<AppSession>("load_session"),
  saveSession: (session: AppSession) => invoke<AppSession>("save_session", { session }),
  openRepository: (path: string) =>
    invoke<WorkspaceSnapshot>("open_repository", { path }),
  refreshWorkspace: (repoPath: string) =>
    invoke<WorkspaceSnapshot>("refresh_workspace", { repoPath }),
  getCommits: (repoPath: string, limit = 80, skip = 0) =>
    invoke<CommitSummary[]>("get_commits", { repoPath, limit, skip }),
  getBranches: (repoPath: string) => invoke<BranchList>("get_branches", { repoPath }),
  getWorkdirDiff: (repoPath: string, path: string, staged: boolean) =>
    invoke<FileDiff>("get_workdir_diff", { repoPath, path, staged }),
  getCommitDetails: (repoPath: string, oid: string) =>
    invoke<CommitDetails>("get_commit_details", { repoPath, oid }),
  getCommitDiff: (repoPath: string, oid: string, path: string) =>
    invoke<FileDiff>("get_commit_diff", { repoPath, oid, path }),
  stagePaths: (repoPath: string, paths: string[]) =>
    invoke<WorkspaceSnapshot>("stage_paths", { repoPath, paths }),
  unstagePaths: (repoPath: string, paths: string[]) =>
    invoke<WorkspaceSnapshot>("unstage_paths", { repoPath, paths }),
  discardPaths: (repoPath: string, paths: string[]) =>
    invoke<WorkspaceSnapshot>("discard_paths", { repoPath, paths }),
  commit: (repoPath: string, message: string, amend = false) =>
    invoke<WorkspaceSnapshot>("commit_changes", { repoPath, message, amend }),
  checkoutBranch: (repoPath: string, name: string) =>
    invoke<WorkspaceSnapshot>("checkout_branch", { repoPath, name }),
  fetchRemote: (repoPath: string, activityId?: string) =>
    invoke<WorkspaceSnapshot>("fetch_remote", { repoPath, activityId }),
  pullRemote: (repoPath: string, activityId?: string) =>
    invoke<WorkspaceSnapshot>("pull_remote", { repoPath, activityId }),
  pushRemote: (repoPath: string, activityId?: string) =>
    invoke<WorkspaceSnapshot>("push_remote", { repoPath, activityId }),
  createBranch: (repoPath: string, name: string, switchTo: boolean) =>
    invoke<WorkspaceSnapshot>("create_branch", {
      repoPath,
      name,
      switch: switchTo,
    }),
  stashSave: (repoPath: string, message: string, includeUntracked: boolean) =>
    invoke<WorkspaceSnapshot>("stash_save", { repoPath, message, includeUntracked }),
  stashApply: (repoPath: string, index: number) =>
    invoke<WorkspaceSnapshot>("stash_apply", { repoPath, index }),
  stashPop: (repoPath: string, index: number) =>
    invoke<WorkspaceSnapshot>("stash_pop", { repoPath, index }),
  stashDrop: (repoPath: string, index: number) =>
    invoke<WorkspaceSnapshot>("stash_drop", { repoPath, index }),
  getGitIdentity: () => invoke<GitIdentity>("get_git_identity"),
  setGitIdentity: (identity: GitIdentity) =>
    invoke<GitIdentity>("set_git_identity", { identity }),
  getLocalGitIdentity: (repoPath: string) =>
    invoke<GitIdentity>("get_local_git_identity", { repoPath }),
  setLocalGitIdentity: (repoPath: string, identity: GitIdentity) =>
    invoke<GitIdentity>("set_local_git_identity", { repoPath, identity }),
  openInFileManager: (path: string) => invoke<void>("open_in_file_manager", { path }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  listTerminals: () => invoke<TerminalOption[]>("list_terminals"),
  getPrefs: () => invoke<AppPrefs>("get_prefs"),
  setPrefs: (prefs: AppPrefs) => invoke<AppPrefs>("set_prefs", { prefs }),
  syncWatches: (paths: string[]) => invoke<void>("sync_watches", { paths }),
};
