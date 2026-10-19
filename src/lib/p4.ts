import { invoke } from "@tauri-apps/api/core";
import type {
  P4Auth,
  P4ChangePage,
  P4Changelist,
  P4CheckedConnection,
  P4Connection,
  P4CreateRequest,
  P4DepotEntry,
  P4StreamOption,
  P4Describe,
  P4DirEntry,
  P4FileSearch,
  P4GetRevision,
  P4Executables,
  P4OpenResult,
  P4ResolveView,
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
  submitted: (
    connection: P4Connection,
    user: string,
    client: string,
    limit = 50,
    before?: number | null,
  ) => call<P4ChangePage>("p4_submitted", { connection, user, client, limit, before: before ?? null }),
  searchSubmitted: (
    connection: P4Connection,
    user: string,
    client: string,
    query: string,
    before: number | null,
    matchLimit: number,
    scanLimit: number,
  ) =>
    call<P4ChangePage>("p4_search_submitted", {
      connection,
      user,
      client,
      query,
      before,
      matchLimit,
      scanLimit,
    }),
  listUsers: (connection: P4Connection) => call<string[]>("p4_list_users", { connection }),
  listClients: (connection: P4Connection, user: string) =>
    call<string[]>("p4_list_clients", { connection, user }),
  describe: (connection: P4Connection, changeId: string) =>
    call<P4Describe>("p4_describe", { connection, changeId }),
  openedDiff: (connection: P4Connection, path: string) =>
    call<FileDiff>("p4_opened_diff", { connection, path }),
  shelfDiff: (connection: P4Connection, depotPath: string, changeId: string) =>
    call<FileDiff>("p4_shelf_diff", { connection, depotPath, changeId }),
  revisionDiff: (connection: P4Connection, depotPath: string, rev: string) =>
    call<FileDiff>("p4_revision_diff", { connection, depotPath, rev }),
  filelog: (connection: P4Connection, path: string) =>
    call<P4Revision[]>("p4_filelog", { connection, path }),
  listDir: (connection: P4Connection, relative: string) =>
    call<P4DirEntry[]>("p4_list_dir", { connection, relative }),
  searchFiles: (connection: P4Connection, query: string) =>
    call<P4FileSearch>("p4_search_files", { connection, query }),
  saveWorkspace: (connection: P4Connection, root: string, stream: string) =>
    call<P4Connection>("p4_save_workspace", { connection, root, stream }),
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
  resolveView: (connection: P4Connection, path: string) =>
    call<P4ResolveView>("p4_resolve_view", { connection, path }),
  resolveAccept: (connection: P4Connection, path: string, mode: "yours" | "theirs" | "merge") =>
    call<void>("p4_resolve_accept", { connection, path, mode }),
  sync: (connection: P4Connection, paths: string[], activityId?: string) =>
    call<string>("p4_sync", { connection, paths, activityId: activityId ?? null }),
  getRevision: (connection: P4Connection, request: P4GetRevision, activityId?: string) =>
    call<string>("p4_get_revision", { connection, request, activityId: activityId ?? null }),
  reconcile: (connection: P4Connection, activityId?: string) =>
    call<string>("p4_reconcile", { connection, activityId: activityId ?? null }),
  fileAction: (connection: P4Connection, action: "edit" | "add" | "delete", paths: string[]) =>
    call<void>("p4_file_action", { connection, action, paths }),
  login: (connection: P4Connection, password: string) =>
    call<void>("p4_login", { connection, password }),
  checkConnection: (auth: P4Auth) => call<P4CheckedConnection>("p4_check_connection", { auth }),
  listStreams: (auth: P4Auth) => call<P4StreamOption[]>("p4_list_streams", { auth }),
  listDepotDirs: (auth: P4Auth, path: string) =>
    call<P4DepotEntry[]>("p4_list_depot_dirs", { auth, path }),
  prepareClient: (auth: P4Auth, client: string) =>
    call<string>("p4_prepare_client", { auth, client }),
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

export function p4ActionLetter(action: string): string {
  const value = action.toLowerCase();
  if (value.includes("add")) return "A";
  if (value.includes("delete")) return "D";
  if (value.includes("edit")) return "E";
  if (value.includes("move") || value.includes("rename")) return "R";
  if (value.includes("branch")) return "B";
  if (value.includes("integrate")) return "I";
  return (value.slice(0, 1) || "?").toUpperCase();
}

export function p4ActionClass(action: string): string {
  const value = action.toLowerCase();
  if (value.includes("add") || value.includes("branch")) return "text-diff-add";
  if (value.includes("delete")) return "text-diff-del";
  if (value.includes("integrate") || value.includes("move") || value.includes("rename")) return "text-diff-hunk";
  return "text-amber-600 dark:text-amber-400";
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
