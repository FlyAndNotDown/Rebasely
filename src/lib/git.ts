import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  AppPrefs,
  AppSession,
  BranchInfo,
  BranchList,
  CommitDetails,
  CommitFile,
  CommitSummary,
  DirEntry,
  FileSearch,
  FileText,
  BlameHunk,
  ConflictView,
  RebaseCommit,
  RebaseStep,
  FileDiff,
  StashDetails,
  GitExecutables,
  GitIdentity,
  ImagePair,
  FileSource,
  LineAction,
  LineRef,
  RecentRepo,
  ReflogEntry,
  RemoteProbe,
  SubmoduleInfo,
  UndoneCommit,
  WorktreeInfo,
  TerminalOption,
  ToolConfig,
  SshKeyInfo,
  SshKeyList,
  SshKeyPreview,
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

/** Matches `GIT_MISSING` in the Rust backend. */
export const GIT_MISSING = "Git executable was not found. Choose one in Settings.";

const GIT_MISSING_EVENT = "rebasely-git-missing";

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(command, args).catch((error: unknown) => {
    if (errorMessage(error) === GIT_MISSING) {
      window.dispatchEvent(new Event(GIT_MISSING_EVENT));
    }
    throw error;
  });
}

export function subscribeGitMissing(listener: () => void) {
  const onMissing = () => listener();
  window.addEventListener(GIT_MISSING_EVENT, onMissing);
  return () => window.removeEventListener(GIT_MISSING_EVENT, onMissing);
}

export const gitApi = {
  listRecents: () => call<RecentRepo[]>("list_recents"),
  forgetRecent: (path: string) => call<RecentRepo[]>("forget_recent", { path }),
  loadSession: () => call<AppSession>("load_session"),
  saveSession: (session: AppSession) => call<AppSession>("save_session", { session }),
  openRepository: (path: string) =>
    call<WorkspaceSnapshot>("open_repository", { path }),
  cloneRepository: (url: string, destination: string, activityId?: string) =>
    call<string>("clone_repository", {
      url,
      destination,
      activityId: activityId || null,
    }),
  cancelActivity: (id: string) => call<boolean>("cancel_activity", { id }),
  answerAskpass: (id: number, answer: string | null) =>
    call<void>("answer_askpass", { id, answer }),
  refreshWorkspace: (repoPath: string) =>
    call<WorkspaceSnapshot>("refresh_workspace", { repoPath }),
  getCommits: (repoPath: string, limit = 80, skip = 0, query?: string, revs?: string[] | null) =>
    call<CommitSummary[]>("get_commits", {
      repoPath,
      limit,
      skip,
      query: query || null,
      rev: revs?.length ? revs : null,
    }),
  getBranches: (repoPath: string) => call<BranchList>("get_branches", { repoPath }),
  getWorkdirDiff: (repoPath: string, path: string, staged: boolean, ignoreWhitespace = false) =>
    call<FileDiff>("get_workdir_diff", { repoPath, path, staged, ignoreWhitespace }),
  listDirectory: (repoPath: string, path: string) =>
    call<DirEntry[]>("list_directory", { repoPath, path }),
  searchFiles: (repoPath: string, query: string) => call<FileSearch>("search_files", { repoPath, query }),
  readFile: (repoPath: string, path: string) => call<FileText>("read_file", { repoPath, path }),
  fileBlame: (repoPath: string, path: string) => call<BlameHunk[]>("file_blame", { repoPath, path }),
  fileCommits: (repoPath: string, path: string, limit: number, skip: number) =>
    call<CommitSummary[]>("file_commits", { repoPath, path, limit, skip }),
  getCommitDetails: (repoPath: string, oid: string) =>
    call<CommitDetails>("get_commit_details", { repoPath, oid }),
  getCommitDiff: (repoPath: string, oid: string, path: string, ignoreWhitespace = false) =>
    call<FileDiff>("get_commit_diff", { repoPath, oid, path, ignoreWhitespace }),
  getImagePair: (repoPath: string, source: FileSource) =>
    call<ImagePair>("get_image_pair", { repoPath, source }),
  compareRevisions: (repoPath: string, base: string, head: string) =>
    call<CommitFile[]>("compare_revisions", { repoPath, base, head }),
  compareFileDiff: (repoPath: string, base: string, head: string, path: string, ignoreWhitespace = false) =>
    call<FileDiff>("compare_file_diff", { repoPath, base, head, path, ignoreWhitespace }),
  stagePaths: (repoPath: string, paths: string[]) =>
    call<WorkspaceSnapshot>("stage_paths", { repoPath, paths }),
  unstagePaths: (repoPath: string, paths: string[]) =>
    call<WorkspaceSnapshot>("unstage_paths", { repoPath, paths }),
  applyLines: (repoPath: string, path: string, staged: boolean, action: LineAction, lines: LineRef[]) =>
    call<WorkspaceSnapshot>("apply_lines", { repoPath, path, staged, action, lines }),
  discardPaths: (repoPath: string, paths: string[]) =>
    call<WorkspaceSnapshot>("discard_paths", { repoPath, paths }),
  commit: (repoPath: string, message: string, amend = false) =>
    call<WorkspaceSnapshot>("commit_changes", { repoPath, message, amend }),
  checkoutBranch: (repoPath: string, name: string) =>
    call<WorkspaceSnapshot>("checkout_branch", { repoPath, name }),
  checkoutDetached: (repoPath: string, oid: string) =>
    call<WorkspaceSnapshot>("checkout_detached", { repoPath, oid }),
  headReflog: (repoPath: string, limit = 200) => call<ReflogEntry[]>("head_reflog", { repoPath, limit }),
  listSubmodules: (repoPath: string) => call<SubmoduleInfo[]>("list_submodules", { repoPath }),
  updateSubmodules: (repoPath: string, paths: string[], activityId?: string) =>
    call<WorkspaceSnapshot>("update_submodules", {
      repoPath,
      paths: paths.length ? paths : null,
      activityId: activityId || null,
    }),
  listWorktrees: (repoPath: string) => call<WorktreeInfo[]>("list_worktrees", { repoPath }),
  addWorktree: (
    repoPath: string,
    path: string,
    options: { branch?: string; newBranch?: string; start?: string },
  ) =>
    call<string>("add_worktree", {
      repoPath,
      path,
      branch: options.branch || null,
      newBranch: options.newBranch || null,
      start: options.start || null,
    }),
  removeWorktree: (repoPath: string, path: string, force = false) =>
    call<void>("remove_worktree", { repoPath, path, force }),
  pruneWorktrees: (repoPath: string) => call<void>("prune_worktrees", { repoPath }),
  undoLastCommit: (repoPath: string) => call<UndoneCommit>("undo_last_commit", { repoPath }),
  fetchRemote: (
    repoPath: string,
    activityId?: string,
    remote?: string,
    all = false,
    options?: { prune?: boolean; background?: boolean },
  ) =>
    call<WorkspaceSnapshot>("fetch_remote", {
      repoPath,
      activityId,
      remote: remote || null,
      all,
      prune: options?.prune ?? false,
      background: options?.background ?? false,
    }),
  deleteRemoteTag: (repoPath: string, remote: string, name: string, activityId?: string) =>
    call<WorkspaceSnapshot>("delete_remote_tag", { repoPath, remote, name, activityId: activityId || null }),
  addRemote: (repoPath: string, name: string, url: string) =>
    call<WorkspaceSnapshot>("add_remote", { repoPath, name, url }),
  deleteRemote: (repoPath: string, name: string) =>
    call<WorkspaceSnapshot>("delete_remote", { repoPath, name }),
  probeRemoteUrl: (repoPath: string, url: string) =>
    call<RemoteProbe>("probe_remote_url", { repoPath, url }),
  pullRemote: (repoPath: string, activityId?: string, remote?: string, rebase = false) =>
    call<WorkspaceSnapshot>("pull_remote", {
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
    call<WorkspaceSnapshot>("push_remote", {
      repoPath,
      activityId,
      remote: options?.remote || null,
      force: options?.force ?? false,
      setUpstream: options?.setUpstream ?? false,
    }),
  createTag: (repoPath: string, name: string, message?: string, target?: string) =>
    call<WorkspaceSnapshot>("create_tag", {
      repoPath,
      name,
      message: message || null,
      target: target || null,
    }),
  deleteTag: (repoPath: string, name: string) =>
    call<WorkspaceSnapshot>("delete_tag", { repoPath, name }),
  pushTag: (repoPath: string, remote: string, name: string, activityId?: string) =>
    call<WorkspaceSnapshot>("push_tag", {
      repoPath,
      remote,
      name,
      activityId: activityId || null,
    }),
  createBranch: (repoPath: string, name: string, switchTo: boolean, start?: string) =>
    call<WorkspaceSnapshot>("create_branch", {
      repoPath,
      name,
      switch: switchTo,
      start: start || null,
    }),
  deleteBranch: (repoPath: string, name: string, activityId?: string, force = false) =>
    call<WorkspaceSnapshot>("delete_branch", {
      repoPath,
      name,
      force,
      activityId: activityId || null,
    }),
  revertCommit: (repoPath: string, oid: string) =>
    call<WorkspaceSnapshot>("revert_commit", { repoPath, oid }),
  cherryPickCommit: (repoPath: string, oid: string) =>
    call<WorkspaceSnapshot>("cherry_pick_commit", { repoPath, oid }),
  rebasePlan: (repoPath: string, onto: string) =>
    call<RebaseCommit[]>("rebase_plan", { repoPath, onto }),
  rebaseOnto: (repoPath: string, onto: string) =>
    call<WorkspaceSnapshot>("rebase_onto", { repoPath, onto }),
  rebaseInteractive: (repoPath: string, onto: string, steps: RebaseStep[]) =>
    call<WorkspaceSnapshot>("rebase_interactive", { repoPath, onto, steps }),
  rebaseContinue: (repoPath: string) =>
    call<WorkspaceSnapshot>("rebase_continue", { repoPath }),
  rebaseSkip: (repoPath: string) => call<WorkspaceSnapshot>("rebase_skip", { repoPath }),
  rebaseAbort: (repoPath: string) => call<WorkspaceSnapshot>("rebase_abort", { repoPath }),
  mergeRef: (repoPath: string, onto: string) =>
    call<WorkspaceSnapshot>("merge_ref", { repoPath, onto }),
  operationContinue: (repoPath: string, message?: string) =>
    call<WorkspaceSnapshot>("operation_continue", { repoPath, message: message || null }),
  operationAbort: (repoPath: string) =>
    call<WorkspaceSnapshot>("operation_abort", { repoPath }),
  resolveConflict: (repoPath: string, path: string, side: "ours" | "theirs" | "both") =>
    call<WorkspaceSnapshot>("resolve_conflict", { repoPath, path, side }),
  conflictView: (repoPath: string, path: string) =>
    call<ConflictView>("conflict_view", { repoPath, path }),
  saveConflict: (repoPath: string, path: string, text: string) =>
    call<WorkspaceSnapshot>("save_conflict", { repoPath, path, text }),
  resetToCommit: (repoPath: string, oid: string, mode: string) =>
    call<WorkspaceSnapshot>("reset_to_commit", { repoPath, oid, mode }),
  writeCommitPatch: (repoPath: string, oid: string, dest: string) =>
    call<void>("write_commit_patch", { repoPath, oid, dest }),
  applyPatch: (repoPath: string, patchPath: string) =>
    call<WorkspaceSnapshot>("apply_patch", { repoPath, patchPath }),
  stashSave: (repoPath: string, message: string, includeUntracked: boolean, paths?: string[]) =>
    call<WorkspaceSnapshot>("stash_save", {
      repoPath,
      message,
      includeUntracked,
      paths: paths?.length ? paths : null,
    }),
  stashApply: (repoPath: string, id: string) =>
    call<WorkspaceSnapshot>("stash_apply", { repoPath, id }),
  stashPop: (repoPath: string, id: string) =>
    call<WorkspaceSnapshot>("stash_pop", { repoPath, id }),
  stashDrop: (repoPath: string, id: string) =>
    call<WorkspaceSnapshot>("stash_drop", { repoPath, id }),
  getStashDetails: (repoPath: string, oid: string) =>
    call<StashDetails>("get_stash_details", { repoPath, oid }),
  getStashDiff: (repoPath: string, oid: string, path: string, ignoreWhitespace = false) =>
    call<FileDiff>("get_stash_diff", { repoPath, oid, path, ignoreWhitespace }),
  getGitIdentity: () => call<GitIdentity>("get_git_identity"),
  setGitIdentity: (identity: GitIdentity) =>
    call<GitIdentity>("set_git_identity", { identity }),
  getLocalGitIdentity: (repoPath: string) =>
    call<GitIdentity>("get_local_git_identity", { repoPath }),
  setLocalGitIdentity: (repoPath: string, identity: GitIdentity) =>
    call<GitIdentity>("set_local_git_identity", { repoPath, identity }),
  openInFileManager: (path: string) => call<void>("open_in_file_manager", { path }),
  openMailto: (email: string) => call<void>("open_mailto", { email }),
  revealInFileManager: (path: string) => call<void>("reveal_in_file_manager", { path }),
  ignorePatterns: (repoPath: string, patterns: string[]) =>
    call<WorkspaceSnapshot>("ignore_patterns", { repoPath, patterns }),
  openInTerminal: (path: string) => call<void>("open_in_terminal", { path }),
  listTerminals: () => call<TerminalOption[]>("list_terminals"),
  listEditors: () => call<TerminalOption[]>("list_editors"),
  openInEditor: (path: string, line?: number | null) =>
    call<void>("open_in_editor", { path, line: line ?? null }),
  getToolConfig: (repoPath?: string) => call<ToolConfig>("get_tool_config", { repoPath: repoPath ?? null }),
  setToolConfig: (config: ToolConfig) => call<ToolConfig>("set_tool_config", { config }),
  listGuiTools: () => call<{ id: string; name: string; installed: boolean }[]>("list_gui_tools"),
  guiToolFound: (value: string) => call<boolean>("gui_tool_found", { value }),
  openDifftool: (repoPath: string, source: FileSource) => call<void>("open_difftool", { repoPath, source }),
  runMergetool: (repoPath: string, path: string) =>
    call<WorkspaceSnapshot>("run_mergetool", { repoPath, path }),
  getPrefs: () => call<AppPrefs>("get_prefs"),
  setPrefs: (prefs: AppPrefs) => call<AppPrefs>("set_prefs", { prefs }),
  gitExecutables: () => call<GitExecutables>("git_executables"),
  checkGitExecutable: (path: string) => call<void>("check_git_executable", { path }),
  listSshKeys: () => call<SshKeyList>("list_ssh_keys"),
  previewSshKey: (path: string) => call<SshKeyPreview>("preview_ssh_key", { path }),
  generateSshKey: (name: string, algorithm: "ed25519" | "rsa", comment: string, passphrase: string) =>
    call<SshKeyInfo>("generate_ssh_key", { name, algorithm, comment, passphrase }),
  importSshKey: (path: string, passphrase: string) =>
    call<SshKeyInfo>("import_ssh_key", { path, passphrase }),
  deleteSshKey: (name: string) => call<void>("delete_ssh_key", { name }),
  syncWatches: (paths: string[]) => call<void>("sync_watches", { paths }),
};
