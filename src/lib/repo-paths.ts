import { normalizeRepoPath } from "@/lib/format";

export type RepoChangedPayload = { path: string; paths?: string[]; overflow?: boolean };

/** `changed` relative to `repoPath`, lowercased with forward slashes; null when outside the repo. */
export function repoRelative(repoPath: string, changed: string): string | null {
  const root = normalizeRepoPath(repoPath);
  const norm = normalizeRepoPath(changed);
  if (norm === root) return "";
  if (!norm.startsWith(`${root}\\`)) return null;
  return norm.slice(root.length + 1).replace(/\\/g, "/");
}

function parentDir(rel: string) {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "" : rel.slice(0, slash);
}

function insideGitDir(rel: string) {
  return rel === ".git" || rel.startsWith(".git/");
}

/**
 * Expanded folders whose listing may have changed. `changed` is null when the
 * watcher overflowed and could not say which paths moved.
 */
export function dirsToReload(repoPath: string, changed: string[] | null, loaded: string[]): string[] {
  if (changed === null || changed.length === 0) return loaded;
  const byKey = new Map(loaded.map((dir) => [dir.toLowerCase(), dir]));
  const dirs = new Set<string>();
  for (const path of changed) {
    const rel = repoRelative(repoPath, path);
    if (rel === null || rel === "" || insideGitDir(rel)) continue;
    const dir = byKey.get(parentDir(rel));
    if (dir !== undefined) dirs.add(dir);
  }
  return [...dirs];
}

/** Whether an open file's text or blame may be stale: the file itself changed, or HEAD, refs, or the index did. */
export function touchesFile(repoPath: string, changed: string[] | null, file: string): boolean {
  if (changed === null || changed.length === 0) return true;
  const target = file.toLowerCase();
  return changed.some((path) => {
    const rel = repoRelative(repoPath, path);
    return rel !== null && (rel === target || insideGitDir(rel));
  });
}
