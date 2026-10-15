import { invoke } from "@tauri-apps/api/core";
import type {
  P4ChangePage,
  P4Changelist,
  P4Connection,
  P4CreateRequest,
  P4Describe,
  P4DirEntry,
  P4Executables,
  P4OpenResult,
  P4Revision,
  RepoDetection,
} from "@/types/p4";
import type { FileDiff } from "@/types/git";

/** Matches `P4_MISSING` in the Rust backend. */
export const P4_MISSING = "p4 executable was not found. Choose one in Settings.";

/** Matches `P4_LOGIN` in the Rust backend. */
export const P4_LOGIN = "Perforce login is required.";

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export const p4Api = {
  detectRepository: (path: string) => call<RepoDetection>("detect_repository", { path }),
  open: (path: string) => call<P4OpenResult>("p4_open", { path }),
  refreshPending: (connection: P4Connection) =>
    call<P4Changelist[]>("p4_refresh_pending", { connection }),
  submitted: (connection: P4Connection, limit = 50, before?: number | null) =>
    call<P4ChangePage>("p4_submitted", { connection, limit, before: before ?? null }),
  describe: (connection: P4Connection, changeId: string) =>
    call<P4Describe>("p4_describe", { connection, changeId }),
  openedDiff: (connection: P4Connection, path: string) =>
    call<FileDiff>("p4_opened_diff", { connection, path }),
  revisionDiff: (connection: P4Connection, depotPath: string, rev: string) =>
    call<FileDiff>("p4_revision_diff", { connection, depotPath, rev }),
  filelog: (connection: P4Connection, path: string) =>
    call<P4Revision[]>("p4_filelog", { connection, path }),
  listDir: (connection: P4Connection, relative: string) =>
    call<P4DirEntry[]>("p4_list_dir", { connection, relative }),
  submit: (connection: P4Connection, changeId: string, description: string) =>
    call<void>("p4_submit", { connection, changeId, description }),
  saveChange: (connection: P4Connection, changeId: string, description: string) =>
    call<string>("p4_save_change", { connection, changeId, description }),
  newChange: (connection: P4Connection, description: string) =>
    call<string>("p4_new_change", { connection, description }),
  reopen: (connection: P4Connection, changeId: string, files: string[]) =>
    call<void>("p4_reopen", { connection, changeId, files }),
  revert: (connection: P4Connection, files: string[]) => call<void>("p4_revert", { connection, files }),
  revertUnchanged: (connection: P4Connection) => call<void>("p4_revert_unchanged", { connection }),
  shelve: (connection: P4Connection, changeId: string) =>
    call<void>("p4_shelve", { connection, changeId }),
  unshelve: (connection: P4Connection, changeId: string) =>
    call<void>("p4_unshelve", { connection, changeId }),
  deleteShelf: (connection: P4Connection, changeId: string) =>
    call<void>("p4_delete_shelf", { connection, changeId }),
  sync: (connection: P4Connection, paths: string[], activityId?: string) =>
    call<string>("p4_sync", { connection, paths, activityId: activityId ?? null }),
  reconcile: (connection: P4Connection, activityId?: string) =>
    call<string>("p4_reconcile", { connection, activityId: activityId ?? null }),
  fileAction: (connection: P4Connection, action: "edit" | "add" | "delete", paths: string[]) =>
    call<void>("p4_file_action", { connection, action, paths }),
  login: (connection: P4Connection, password: string) =>
    call<void>("p4_login", { connection, password }),
  createWorkspace: (request: P4CreateRequest, activityId?: string) =>
    call<P4Connection>("p4_create_workspace", { request, activityId: activityId ?? null }),
  executables: () => call<P4Executables>("p4_executables"),
  checkExecutable: (path: string) => call<void>("check_p4_executable", { path }),
};

export function changeSummary(description: string): string {
  return description
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

export function depotBase(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function relativeToRoot(root: string, path: string): string {
  const parts = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const rootParts = parts(root);
  const pathParts = parts(path);
  let index = 0;
  while (
    index < rootParts.length &&
    index < pathParts.length &&
    rootParts[index].toLowerCase() === pathParts[index].toLowerCase()
  ) {
    index += 1;
  }
  if (index !== rootParts.length) return "";
  return pathParts.slice(index).join("/");
}
