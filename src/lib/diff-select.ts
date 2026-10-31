import type { DiffLine, LineRef } from "@/types/git";

export function isChange(line: DiffLine | undefined) {
  return line?.kind === "add" || line?.kind === "delete";
}

/** The changed line indices under each hunk header, keyed by the header's index. */
export function hunkChanges(lines: DiffLine[]): Map<number, number[]> {
  const hunks = new Map<number, number[]>();
  let current: number[] | null = null;
  lines.forEach((line, index) => {
    if (line.kind === "hunk") {
      current = [];
      hunks.set(index, current);
    } else if (current && isChange(line)) {
      current.push(index);
    }
  });
  return hunks;
}

/** Changed line indices from `from` to `to` inclusive, in either direction. */
export function changeRange(lines: DiffLine[], from: number, to: number): number[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const picked: number[] = [];
  for (let index = start; index <= end; index += 1) {
    if (isChange(lines[index])) picked.push(index);
  }
  return picked;
}

export type SplitRow =
  | { kind: "hunk"; index: number }
  | { kind: "pair"; left: number | null; right: number | null };

/**
 * Rows for a side-by-side view: context on both sides, and each run of
 * removals paired line by line with the additions that follow it.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "hunk") {
      rows.push({ kind: "hunk", index });
      index += 1;
      continue;
    }
    if (line.kind !== "delete" && line.kind !== "add") {
      rows.push({ kind: "pair", left: index, right: index });
      index += 1;
      continue;
    }
    const deletes: number[] = [];
    while (index < lines.length && lines[index].kind === "delete") deletes.push(index++);
    const adds: number[] = [];
    while (index < lines.length && lines[index].kind === "add") adds.push(index++);
    for (let pair = 0; pair < Math.max(deletes.length, adds.length); pair += 1) {
      rows.push({ kind: "pair", left: deletes[pair] ?? null, right: adds[pair] ?? null });
    }
  }
  return rows;
}

export function lineRefs(lines: DiffLine[], indices: Iterable<number>): LineRef[] {
  const refs: LineRef[] = [];
  for (const index of [...indices].sort((left, right) => left - right)) {
    const line = lines[index];
    if (line?.kind === "add" && line.newLineno != null) refs.push({ old: null, new: line.newLineno });
    if (line?.kind === "delete" && line.oldLineno != null) refs.push({ old: line.oldLineno, new: null });
  }
  return refs;
}
