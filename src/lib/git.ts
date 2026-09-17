import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetails,
  CommitSummary,
  FileDiff,
  RecentRepo,
  WorkspaceSnapshot,
} from "@/types/git";

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const gitApi = {
  listRecents: () => invoke<RecentRepo[]>("list_recents"),
  forgetRecent: (path: string) => invoke<RecentRepo[]>("forget_recent", { path }),
  openRepository: (path: string) =>
    invoke<WorkspaceSnapshot>("open_repository", { path }),
  closeRepository: () => invoke<void>("close_repository"),
  refreshWorkspace: () => invoke<WorkspaceSnapshot>("refresh_workspace"),
  getCommits: (limit = 100) => invoke<CommitSummary[]>("get_commits", { limit }),
  getWorkdirDiff: (path: string, staged: boolean) =>
    invoke<FileDiff>("get_workdir_diff", { path, staged }),
  getCommitDetails: (oid: string) =>
    invoke<CommitDetails>("get_commit_details", { oid }),
  getCommitDiff: (oid: string, path: string) =>
    invoke<FileDiff>("get_commit_diff", { oid, path }),
  stagePaths: (paths: string[]) =>
    invoke<WorkspaceSnapshot>("stage_paths", { paths }),
  unstagePaths: (paths: string[]) =>
    invoke<WorkspaceSnapshot>("unstage_paths", { paths }),
  discardPaths: (paths: string[]) =>
    invoke<WorkspaceSnapshot>("discard_paths", { paths }),
  commit: (message: string) =>
    invoke<WorkspaceSnapshot>("commit_changes", { message }),
  checkoutBranch: (name: string) =>
    invoke<WorkspaceSnapshot>("checkout_branch", { name }),
  createBranch: (name: string, switchTo: boolean) =>
    invoke<WorkspaceSnapshot>("create_branch", { name, switch: switchTo }),
};
