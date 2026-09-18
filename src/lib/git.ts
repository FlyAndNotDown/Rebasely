import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetails,
  CommitSummary,
  FileDiff,
  RecentRepo,
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
  openRepository: (path: string) =>
    invoke<WorkspaceSnapshot>("open_repository", { path }),
  refreshWorkspace: (repoPath: string) =>
    invoke<WorkspaceSnapshot>("refresh_workspace", { repoPath }),
  getCommits: (repoPath: string, limit = 100) =>
    invoke<CommitSummary[]>("get_commits", { repoPath, limit }),
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
  commit: (repoPath: string, message: string) =>
    invoke<WorkspaceSnapshot>("commit_changes", { repoPath, message }),
  checkoutBranch: (repoPath: string, name: string) =>
    invoke<WorkspaceSnapshot>("checkout_branch", { repoPath, name }),
  createBranch: (repoPath: string, name: string, switchTo: boolean) =>
    invoke<WorkspaceSnapshot>("create_branch", {
      repoPath,
      name,
      switch: switchTo,
    }),
};
