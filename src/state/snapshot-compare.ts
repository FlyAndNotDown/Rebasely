import { normalizeRepoPath } from "@/lib/format";
import type { FileDiff, FileStatus, WorkspaceSnapshot } from "@/types/git";

export function keepRemoteBranches(
  previous: WorkspaceSnapshot | null | undefined,
  next: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (next.branches.remote.length > 0 || !previous?.branches.remote.length) return next;
  return {
    ...next,
    branches: {
      ...next.branches,
      remote: previous.branches.remote,
    },
  };
}

export function historyGraphChanged(
  previous: WorkspaceSnapshot | null | undefined,
  next: WorkspaceSnapshot,
) {
  const before = previous?.repo;
  const after = next.repo;
  if (!before) return true;
  return (
    before.headId !== after.headId ||
    before.ahead !== after.ahead ||
    before.behind !== after.behind ||
    before.upstream !== after.upstream
  );
}

export type RefreshHint = { paths: string[]; overflow: boolean };

export function mergeRefreshHint(into: RefreshHint, extra: RefreshHint) {
  if (into.overflow || extra.overflow) {
    into.overflow = true;
    into.paths = [];
    return;
  }
  for (const path of extra.paths) {
    if (!into.paths.includes(path)) into.paths.push(path);
  }
  if (into.paths.length > 48) {
    into.overflow = true;
    into.paths = [];
  }
}

export function watchTouchesFile(changed: string, repoPath: string, filePath: string) {
  const norm = normalizeRepoPath(changed);
  if (norm.includes("\\.git\\") || norm.endsWith("\\.git")) return true;
  const full = normalizeRepoPath(`${repoPath.replace(/[\\/]+$/, "")}/${filePath}`);
  return norm === full;
}

export function shouldReloadWorkdirDiff(hint: RefreshHint, repoPath: string, filePath: string) {
  if (hint.overflow || hint.paths.length === 0) return true;
  return hint.paths.some((changed) => watchTouchesFile(changed, repoPath, filePath));
}

export function sameFiles(left: FileStatus[], right: FileStatus[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.path !== b.path || a.oldPath !== b.oldPath || a.kind !== b.kind || a.staged !== b.staged) {
      return false;
    }
  }
  return true;
}

export function sameDiff(left: FileDiff | null, right: FileDiff | null) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.path !== right.path ||
    left.oldPath !== right.oldPath ||
    left.binary !== right.binary ||
    left.truncated !== right.truncated ||
    left.lines.length !== right.lines.length
  ) {
    return false;
  }
  for (let index = 0; index < left.lines.length; index += 1) {
    const a = left.lines[index];
    const b = right.lines[index];
    if (a.kind !== b.kind || a.content !== b.content || a.oldLineno !== b.oldLineno || a.newLineno !== b.newLineno) {
      return false;
    }
  }
  return true;
}

export function sameSnapshot(previous: WorkspaceSnapshot | null | undefined, next: WorkspaceSnapshot) {
  if (!previous) return false;
  const before = previous.repo;
  const after = next.repo;
  if (
    before.headId !== after.headId ||
    before.currentBranch !== after.currentBranch ||
    before.isDetached !== after.isDetached ||
    before.ahead !== after.ahead ||
    before.behind !== after.behind ||
    before.upstream !== after.upstream ||
    before.rebase?.onto !== after.rebase?.onto ||
    before.rebase?.headName !== after.rebase?.headName ||
    before.rebase?.step !== after.rebase?.step ||
    before.rebase?.total !== after.rebase?.total ||
    before.operation?.kind !== after.operation?.kind ||
    before.operation?.onto !== after.operation?.onto ||
    before.operation?.step !== after.operation?.step ||
    before.operation?.total !== after.operation?.total ||
    (previous.headCommit?.id ?? null) !== (next.headCommit?.id ?? null)
  ) {
    return false;
  }
  if (!sameFiles(previous.status.staged, next.status.staged) || !sameFiles(previous.status.unstaged, next.status.unstaged)) {
    return false;
  }
  if (previous.stashes.length !== next.stashes.length || previous.remotes.length !== next.remotes.length) return false;
  for (let index = 0; index < previous.stashes.length; index += 1) {
    const a = previous.stashes[index];
    const b = next.stashes[index];
    if (a.id !== b.id || a.index !== b.index || a.message !== b.message) return false;
  }
  for (let index = 0; index < previous.remotes.length; index += 1) {
    const a = previous.remotes[index];
    const b = next.remotes[index];
    if (a.name !== b.name || a.url !== b.url || a.pushUrl !== b.pushUrl) return false;
  }
  if (previous.branches.local.length !== next.branches.local.length || previous.branches.current !== next.branches.current) {
    return false;
  }
  for (let index = 0; index < previous.branches.local.length; index += 1) {
    const a = previous.branches.local[index];
    const b = next.branches.local[index];
    if (a.name !== b.name || a.isHead !== b.isHead || a.upstream !== b.upstream) return false;
  }
  if (previous.branches.tags.length !== next.branches.tags.length) return false;
  for (let index = 0; index < previous.branches.tags.length; index += 1) {
    if (previous.branches.tags[index]?.name !== next.branches.tags[index]?.name) return false;
  }
  if (previous.branches.remote !== next.branches.remote) {
    if (previous.branches.remote.length !== next.branches.remote.length) return false;
    for (let index = 0; index < previous.branches.remote.length; index += 1) {
      const a = previous.branches.remote[index];
      const b = next.branches.remote[index];
      if (a.name !== b.name || a.isHead !== b.isHead || a.upstream !== b.upstream) return false;
    }
  }
  return true;
}

export function sameRevs(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

export function progressFromGitLine(line: string): number | undefined {
  const match = line.match(/(\d+(?:\.\d+)?)%/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}
