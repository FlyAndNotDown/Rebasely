import { invoke } from "@tauri-apps/api/core";
import type {
  AppPrefs,
  AppSession,
  BranchInfo,
  BranchList,
  CommitDetails,
  CommitSummary,
  FileDiff,
  StashDetails,
  GitIdentity,
  RecentRepo,
  RemoteProbe,
  TerminalOption,
  WorkspaceSnapshot,
} from "@/types/git";

export function isRemoteTrackingBranch(name: string, remotes: string[] = []) {
  const trimmed = name.trim();
  if (!trimmed.includes("/") || /(?:^|\/)HEAD$/i.test(trimmed)) return false;
  return !remotes.some((remote) => remote.toLowerCase() === trimmed.toLowerCase());
}

export function expandHistoryRevs(revs: string[] | null | undefined, locals?: BranchInfo[]): string[] {
  if (!revs?.length) return [];
  const extra = (locals ?? [])
    .filter((branch) => revs.includes(branch.name) && branch.upstream)
    .map((branch) => branch.upstream as string);
  return [...new Set([...revs, ...extra])];
}

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
  cloneRepository: (url: string, destination: string, activityId?: string) =>
    invoke<string>("clone_repository", {
      url,
      destination,
      activityId: activityId || null,
    }),
  refreshWorkspace: (repoPath: string) =>
    invoke<WorkspaceSnapshot>("refresh_workspace", { repoPath }),
  getCommits: (repoPath: string, limit = 80, skip = 0, query?: string, revs?: string[] | null) =>
    invoke<CommitSummary[]>("get_commits", {
      repoPath,
      limit,
      skip,
      query: query || null,
      rev: revs?.length ? revs : null,
    }),
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
  fetchRemote: (repoPath: string, activityId?: string, remote?: string, all = false) =>
    invoke<WorkspaceSnapshot>("fetch_remote", {
      repoPath,
      activityId,
      remote: remote || null,
      all,
    }),
  addRemote: (repoPath: string, name: string, url: string) =>
    invoke<WorkspaceSnapshot>("add_remote", { repoPath, name, url }),
  deleteRemote: (repoPath: string, name: string) =>
    invoke<WorkspaceSnapshot>("delete_remote", { repoPath, name }),
  probeRemoteUrl: (repoPath: string, url: string) =>
    invoke<RemoteProbe>("probe_remote_url", { repoPath, url }),
  pullRemote: (repoPath: string, activityId?: string, remote?: string) =>
    invoke<WorkspaceSnapshot>("pull_remote", {
      repoPath,
      activityId,
      remote: remote || null,
    }),
  pushRemote: (
    repoPath: string,
    activityId?: string,
    options?: { remote?: string; force?: boolean; setUpstream?: boolean },
  ) =>
    invoke<WorkspaceSnapshot>("push_remote", {
      repoPath,
      activityId,
      remote: options?.remote || null,
      force: options?.force ?? false,
      setUpstream: options?.setUpstream ?? false,
    }),
  createBranch: (repoPath: string, name: string, switchTo: boolean, start?: string) =>
    invoke<WorkspaceSnapshot>("create_branch", {
      repoPath,
      name,
      switch: switchTo,
      start: start || null,
    }),
  deleteBranch: (repoPath: string, name: string, activityId?: string) =>
    invoke<WorkspaceSnapshot>("delete_branch", {
      repoPath,
      name,
      activityId: activityId || null,
    }),
  revertCommit: (repoPath: string, oid: string) =>
    invoke<WorkspaceSnapshot>("revert_commit", { repoPath, oid }),
  cherryPickCommit: (repoPath: string, oid: string) =>
    invoke<WorkspaceSnapshot>("cherry_pick_commit", { repoPath, oid }),
  resetToCommit: (repoPath: string, oid: string, mode: string) =>
    invoke<WorkspaceSnapshot>("reset_to_commit", { repoPath, oid, mode }),
  writeCommitPatch: (repoPath: string, oid: string, dest: string) =>
    invoke<void>("write_commit_patch", { repoPath, oid, dest }),
  applyPatch: (repoPath: string, patchPath: string) =>
    invoke<WorkspaceSnapshot>("apply_patch", { repoPath, patchPath }),
  stashSave: (repoPath: string, message: string, includeUntracked: boolean) =>
    invoke<WorkspaceSnapshot>("stash_save", { repoPath, message, includeUntracked }),
  stashApply: (repoPath: string, index: number) =>
    invoke<WorkspaceSnapshot>("stash_apply", { repoPath, index }),
  stashPop: (repoPath: string, index: number) =>
    invoke<WorkspaceSnapshot>("stash_pop", { repoPath, index }),
  stashDrop: (repoPath: string, index: number) =>
    invoke<WorkspaceSnapshot>("stash_drop", { repoPath, index }),
  getStashDetails: (repoPath: string, oid: string) =>
    invoke<StashDetails>("get_stash_details", { repoPath, oid }),
  getStashDiff: (repoPath: string, oid: string, path: string) =>
    invoke<FileDiff>("get_stash_diff", { repoPath, oid, path }),
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
