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

export function lineRefs(lines: DiffLine[], indices: Iterable<number>): LineRef[] {
  const refs: LineRef[] = [];
  for (const index of [...indices].sort((left, right) => left - right)) {
    const line = lines[index];
    if (line?.kind === "add" && line.newLineno != null) refs.push({ old: null, new: line.newLineno });
    if (line?.kind === "delete" && line.oldLineno != null) refs.push({ old: line.oldLineno, new: null });
  }
  return refs;
}
