export interface TreeEntry {
  path: string;
  dir: boolean;
}

export interface FileTreeRow<T> {
  entry: T;
  depth: number;
}

/** Only expanded branches contribute rows; collapsed listings are never visited. */
export function fileTreeRows<T extends TreeEntry>(
  entries: Readonly<Record<string, readonly T[]>>,
  open: ReadonlySet<string>,
  dir = "",
  depth = 0,
): FileTreeRow<T>[] {
  const rows: FileTreeRow<T>[] = [];
  const stack = [{ items: entries[dir] ?? [], index: 0, depth }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const entry = frame.items[frame.index++];
    if (!entry) {
      stack.pop();
      continue;
    }
    rows.push({ entry, depth: frame.depth });
    if (entry.dir && open.has(entry.path)) {
      const children = entries[entry.path];
      if (children?.length) stack.push({ items: children, index: 0, depth: frame.depth + 1 });
    }
  }
  return rows;
}
