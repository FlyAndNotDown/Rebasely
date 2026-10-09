import { invoke } from "@tauri-apps/api/core";
import type {
  AppPrefs,
  AppSession,
  BranchInfo,
  BranchList,
  CommitDetails,
  CommitFile,
  CommitSummary,
  DirEntry,
  FileText,
  BlameHunk,
  ConflictView,
  RebaseCommit,
  RebaseStep,
  FileDiff,
  StashDetails,
  GitIdentity,
  ImagePair,
  FileSource,
  LineAction,
  LineRef,
  RecentRepo,
  ReflogEntry,
  RemoteProbe,
  UndoneCommit,
  TerminalOption,
  ToolConfig,
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

/** Matches `CANCELLED` in the Rust backend. */
export function isCancelled(error: unknown) {
  return errorMessage(error) === "Cancelled";
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
  cancelActivity: (id: string) => invoke<boolean>("cancel_activity", { id }),
  answerAskpass: (id: number, answer: string | null) =>
    invoke<void>("answer_askpass", { id, answer }),
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
  getWorkdirDiff: (repoPath: string, path: string, staged: boolean, ignoreWhitespace = false) =>
    invoke<FileDiff>("get_workdir_diff", { repoPath, path, staged, ignoreWhitespace }),
  listDirectory: (repoPath: string, path: string) =>
    invoke<DirEntry[]>("list_directory", { repoPath, path }),
  readFile: (repoPath: string, path: string) => invoke<FileText>("read_file", { repoPath, path }),
  fileBlame: (repoPath: string, path: string) => invoke<BlameHunk[]>("file_blame", { repoPath, path }),
  fileCommits: (repoPath: string, path: string, limit: number, skip: number) =>
    invoke<CommitSummary[]>("file_commits", { repoPath, path, limit, skip }),
  getCommitDetails: (repoPath: string, oid: string) =>
    invoke<CommitDetails>("get_commit_details", { repoPath, oid }),
  getCommitDiff: (repoPath: string, oid: string, path: string, ignoreWhitespace = false) =>
    invoke<FileDiff>("get_commit_diff", { repoPath, oid, path, ignoreWhitespace }),
  getImagePair: (repoPath: string, source: FileSource) =>
    invoke<ImagePair>("get_image_pair", { repoPath, source }),
  compareRevisions: (repoPath: string, base: string, head: string) =>
    invoke<CommitFile[]>("compare_revisions", { repoPath, base, head }),
  compareFileDiff: (repoPath: string, base: string, head: string, path: string, ignoreWhitespace = false) =>
    invoke<FileDiff>("compare_file_diff", { repoPath, base, head, path, ignoreWhitespace }),
  stagePaths: (repoPath: string, paths: string[]) =>
    invoke<WorkspaceSnapshot>("stage_paths", { repoPath, paths }),
  unstagePaths: (repoPath: string, paths: string[]) =>
    invoke<WorkspaceSnapshot>("unstage_paths", { repoPath, paths }),
  applyLines: (repoPath: string, path: string, staged: boolean, action: LineAction, lines: LineRef[]) =>
    invoke<WorkspaceSnapshot>("apply_lines", { repoPath, path, staged, action, lines }),
  discardPaths: (repoPath: string, paths: string[]) =>
    invoke<WorkspaceSnapshot>("discard_paths", { repoPath, paths }),
  commit: (repoPath: string, message: string, amend = false) =>
    invoke<WorkspaceSnapshot>("commit_changes", { repoPath, message, amend }),
  checkoutBranch: (repoPath: string, name: string) =>
    invoke<WorkspaceSnapshot>("checkout_branch", { repoPath, name }),
  checkoutDetached: (repoPath: string, oid: string) =>
    invoke<WorkspaceSnapshot>("checkout_detached", { repoPath, oid }),
  headReflog: (repoPath: string, limit = 200) => invoke<ReflogEntry[]>("head_reflog", { repoPath, limit }),
  undoLastCommit: (repoPath: string) => invoke<UndoneCommit>("undo_last_commit", { repoPath }),
  fetchRemote: (
    repoPath: string,
    activityId?: string,
    remote?: string,
    all = false,
    options?: { prune?: boolean; background?: boolean },
  ) =>
    invoke<WorkspaceSnapshot>("fetch_remote", {
      repoPath,
      activityId,
      remote: remote || null,
      all,
      prune: options?.prune ?? false,
      background: options?.background ?? false,
    }),
  deleteRemoteTag: (repoPath: string, remote: string, name: string, activityId?: string) =>
    invoke<WorkspaceSnapshot>("delete_remote_tag", { repoPath, remote, name, activityId: activityId || null }),
  addRemote: (repoPath: string, name: string, url: string) =>
    invoke<WorkspaceSnapshot>("add_remote", { repoPath, name, url }),
  deleteRemote: (repoPath: string, name: string) =>
    invoke<WorkspaceSnapshot>("delete_remote", { repoPath, name }),
  probeRemoteUrl: (repoPath: string, url: string) =>
    invoke<RemoteProbe>("probe_remote_url", { repoPath, url }),
  pullRemote: (repoPath: string, activityId?: string, remote?: string, rebase = false) =>
    invoke<WorkspaceSnapshot>("pull_remote", {
      repoPath,
      activityId,
      remote: remote || null,
      rebase,
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
  createTag: (repoPath: string, name: string, message?: string, target?: string) =>
    invoke<WorkspaceSnapshot>("create_tag", {
      repoPath,
      name,
      message: message || null,
      target: target || null,
    }),
  deleteTag: (repoPath: string, name: string) =>
    invoke<WorkspaceSnapshot>("delete_tag", { repoPath, name }),
  pushTag: (repoPath: string, remote: string, name: string, activityId?: string) =>
    invoke<WorkspaceSnapshot>("push_tag", {
      repoPath,
      remote,
      name,
      activityId: activityId || null,
    }),
  createBranch: (repoPath: string, name: string, switchTo: boolean, start?: string) =>
    invoke<WorkspaceSnapshot>("create_branch", {
      repoPath,
      name,
      switch: switchTo,
      start: start || null,
    }),
  deleteBranch: (repoPath: string, name: string, activityId?: string, force = false) =>
    invoke<WorkspaceSnapshot>("delete_branch", {
      repoPath,
      name,
      force,
      activityId: activityId || null,
    }),
  revertCommit: (repoPath: string, oid: string) =>
    invoke<WorkspaceSnapshot>("revert_commit", { repoPath, oid }),
  cherryPickCommit: (repoPath: string, oid: string) =>
    invoke<WorkspaceSnapshot>("cherry_pick_commit", { repoPath, oid }),
  rebasePlan: (repoPath: string, onto: string) =>
    invoke<RebaseCommit[]>("rebase_plan", { repoPath, onto }),
  rebaseOnto: (repoPath: string, onto: string) =>
    invoke<WorkspaceSnapshot>("rebase_onto", { repoPath, onto }),
  rebaseInteractive: (repoPath: string, onto: string, steps: RebaseStep[]) =>
    invoke<WorkspaceSnapshot>("rebase_interactive", { repoPath, onto, steps }),
  rebaseContinue: (repoPath: string) =>
    invoke<WorkspaceSnapshot>("rebase_continue", { repoPath }),
  rebaseSkip: (repoPath: string) => invoke<WorkspaceSnapshot>("rebase_skip", { repoPath }),
  rebaseAbort: (repoPath: string) => invoke<WorkspaceSnapshot>("rebase_abort", { repoPath }),
  mergeRef: (repoPath: string, onto: string) =>
    invoke<WorkspaceSnapshot>("merge_ref", { repoPath, onto }),
  operationContinue: (repoPath: string, message?: string) =>
    invoke<WorkspaceSnapshot>("operation_continue", { repoPath, message: message || null }),
  operationAbort: (repoPath: string) =>
    invoke<WorkspaceSnapshot>("operation_abort", { repoPath }),
  resolveConflict: (repoPath: string, path: string, side: "ours" | "theirs" | "both") =>
    invoke<WorkspaceSnapshot>("resolve_conflict", { repoPath, path, side }),
  conflictView: (repoPath: string, path: string) =>
    invoke<ConflictView>("conflict_view", { repoPath, path }),
  saveConflict: (repoPath: string, path: string, text: string) =>
    invoke<WorkspaceSnapshot>("save_conflict", { repoPath, path, text }),
  resetToCommit: (repoPath: string, oid: string, mode: string) =>
    invoke<WorkspaceSnapshot>("reset_to_commit", { repoPath, oid, mode }),
  writeCommitPatch: (repoPath: string, oid: string, dest: string) =>
    invoke<void>("write_commit_patch", { repoPath, oid, dest }),
  applyPatch: (repoPath: string, patchPath: string) =>
    invoke<WorkspaceSnapshot>("apply_patch", { repoPath, patchPath }),
  stashSave: (repoPath: string, message: string, includeUntracked: boolean, paths?: string[]) =>
    invoke<WorkspaceSnapshot>("stash_save", {
      repoPath,
      message,
      includeUntracked,
      paths: paths?.length ? paths : null,
    }),
  stashApply: (repoPath: string, id: string) =>
    invoke<WorkspaceSnapshot>("stash_apply", { repoPath, id }),
  stashPop: (repoPath: string, id: string) =>
    invoke<WorkspaceSnapshot>("stash_pop", { repoPath, id }),
  stashDrop: (repoPath: string, id: string) =>
    invoke<WorkspaceSnapshot>("stash_drop", { repoPath, id }),
  getStashDetails: (repoPath: string, oid: string) =>
    invoke<StashDetails>("get_stash_details", { repoPath, oid }),
  getStashDiff: (repoPath: string, oid: string, path: string, ignoreWhitespace = false) =>
    invoke<FileDiff>("get_stash_diff", { repoPath, oid, path, ignoreWhitespace }),
  getGitIdentity: () => invoke<GitIdentity>("get_git_identity"),
  setGitIdentity: (identity: GitIdentity) =>
    invoke<GitIdentity>("set_git_identity", { identity }),
  getLocalGitIdentity: (repoPath: string) =>
    invoke<GitIdentity>("get_local_git_identity", { repoPath }),
  setLocalGitIdentity: (repoPath: string, identity: GitIdentity) =>
    invoke<GitIdentity>("set_local_git_identity", { repoPath, identity }),
  openInFileManager: (path: string) => invoke<void>("open_in_file_manager", { path }),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  ignorePatterns: (repoPath: string, patterns: string[]) =>
    invoke<WorkspaceSnapshot>("ignore_patterns", { repoPath, patterns }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  listTerminals: () => invoke<TerminalOption[]>("list_terminals"),
  listEditors: () => invoke<TerminalOption[]>("list_editors"),
  openInEditor: (path: string, line?: number | null) =>
    invoke<void>("open_in_editor", { path, line: line ?? null }),
  getToolConfig: (repoPath?: string) => invoke<ToolConfig>("get_tool_config", { repoPath: repoPath ?? null }),
  setToolConfig: (config: ToolConfig) => invoke<ToolConfig>("set_tool_config", { config }),
  openDifftool: (repoPath: string, source: FileSource) => invoke<void>("open_difftool", { repoPath, source }),
  runMergetool: (repoPath: string, path: string) =>
    invoke<WorkspaceSnapshot>("run_mergetool", { repoPath, path }),
  getPrefs: () => invoke<AppPrefs>("get_prefs"),
  setPrefs: (prefs: AppPrefs) => invoke<AppPrefs>("set_prefs", { prefs }),
  syncWatches: (paths: string[]) => invoke<void>("sync_watches", { paths }),
};
