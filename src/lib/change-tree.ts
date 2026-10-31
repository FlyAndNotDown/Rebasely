import { fileName, parentPath } from "@/lib/format";
import type { FileStatus } from "@/types/git";

export type ChangeSection = "unstaged" | "staged";

export interface ChangeDir {
  path: string;
  label: string;
  dirs: ChangeDir[];
  files: FileStatus[];
}

export type ChangeRow =
  | {
      kind: "dir";
      section: ChangeSection;
      path: string;
      label: string;
      depth: number;
      open: boolean;
      paths: string[];
    }
  | { kind: "file"; section: ChangeSection; file: FileStatus; depth: number };

const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;

/** Groups files by folder, folders before files, both sorted by name. */
export function buildChangeTree(files: FileStatus[]): ChangeDir {
  const root: ChangeDir = { path: "", label: "", dirs: [], files: [] };
  const index = new Map<string, ChangeDir>([["", root]]);
  const dirFor = (path: string): ChangeDir => {
    const existing = index.get(path);
    if (existing) return existing;
    const dir: ChangeDir = { path, label: fileName(path), dirs: [], files: [] };
    dirFor(parentPath(path)).dirs.push(dir);
    index.set(path, dir);
    return dir;
  };
  for (const file of files) dirFor(parentPath(file.path)).files.push(file);
  const finish = (dir: ChangeDir): ChangeDir => {
    dir.dirs.sort((left, right) => byName(left.label, right.label));
    dir.files.sort((left, right) => byName(fileName(left.path), fileName(right.path)));
    dir.dirs = dir.dirs.map((child) => compact(finish(child)));
    return dir;
  };
  return finish(root);
}

/** A folder whose only entry is another folder shows as one row, `a/b`. */
function compact(dir: ChangeDir): ChangeDir {
  let current = dir;
  let label = dir.label;
  while (current.files.length === 0 && current.dirs.length === 1) {
    current = current.dirs[0];
    label = `${label}/${current.label}`;
  }
  return current === dir ? dir : { ...current, label };
}

export function filePathsUnder(dir: ChangeDir): string[] {
  const paths = dir.files.map((file) => file.path);
  for (const child of dir.dirs) paths.push(...filePathsUnder(child));
  return paths;
}

/**
 * The visible rows of one section. `collapsed` holds `section:folder` keys;
 * a collapsed folder hides everything below it.
 */
export function changeRows(
  section: ChangeSection,
  files: FileStatus[],
  tree: boolean,
  collapsed: ReadonlySet<string>,
): ChangeRow[] {
  if (!tree) return files.map((file) => ({ kind: "file", section, file, depth: 0 }));
  const rows: ChangeRow[] = [];
  const walk = (dir: ChangeDir, depth: number) => {
    for (const child of dir.dirs) {
      const open = !collapsed.has(`${section}:${child.path}`);
      rows.push({
        kind: "dir",
        section,
        path: child.path,
        label: child.label,
        depth,
        open,
        paths: filePathsUnder(child),
      });
      if (open) walk(child, depth + 1);
    }
    for (const file of dir.files) rows.push({ kind: "file", section, file, depth });
  };
  walk(buildChangeTree(files), 0);
  return rows;
}

function escapeIgnore(text: string) {
  return text.replace(/[\\*?[]/g, (char) => `\\${char}`).replace(/ $/, "\\ ");
}

/** A .gitignore line matching exactly this path from the repository root. */
export function ignorePathPattern(path: string, folder = false) {
  return `/${escapeIgnore(path)}${folder ? "/" : ""}`;
}

/** A .gitignore line matching every file with this file's extension, or null. */
export function ignoreExtensionPattern(path: string) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return `*${escapeIgnore(name.slice(dot))}`;
}

/** The items from `anchor` to `target` inclusive, in list order. */
export function rangeBetween(order: string[], anchor: string | null, target: string): string[] {
  const end = order.indexOf(target);
  if (end === -1) return [];
  const start = anchor === null ? -1 : order.indexOf(anchor);
  if (start === -1) return [target];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}
