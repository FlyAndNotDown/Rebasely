export type ConflictSide = "ours" | "theirs" | "both" | "none";

export interface ConflictHunk {
  ours: string;
  theirs: string;
  base: string;
  hasBase: boolean;
  start: number;
  end: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
}

export type ConflictSegment =
  | { kind: "text"; start: number; end: number; text: string }
  | { kind: "conflict"; index: number; hunk: ConflictHunk };

export function conflictHunks(text: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let from = 0;
  while (from < text.length) {
    const found = readHunk(text, from);
    if (!found) break;
    hunks.push(found);
    from = found.end;
  }
  return hunks;
}

export function conflictSegments(text: string): ConflictSegment[] {
  const hunks = conflictHunks(text);
  const segments: ConflictSegment[] = [];
  let cursor = 0;
  hunks.forEach((hunk, index) => {
    if (hunk.start > cursor) {
      segments.push({ kind: "text", start: cursor, end: hunk.start, text: text.slice(cursor, hunk.start) });
    }
    segments.push({ kind: "conflict", index, hunk });
    cursor = hunk.end;
  });
  if (cursor < text.length || segments.length === 0) {
    segments.push({ kind: "text", start: cursor, end: text.length, text: text.slice(cursor) });
  }
  return segments;
}

export function applyConflictChoice(text: string, index: number, side: ConflictSide): string {
  const hunk = conflictHunks(text)[index];
  if (!hunk) return text;
  return text.slice(0, hunk.start) + sideText(hunk, side) + text.slice(hunk.end);
}

export function setConflictSide(text: string, index: number, side: "ours" | "theirs", value: string): string {
  const hunk = conflictHunks(text)[index];
  if (!hunk) return text;
  const body = value.length === 0 || value.endsWith("\n") ? value : `${value}\n`;
  if (side === "ours") return text.slice(0, hunk.oursStart) + body + text.slice(hunk.oursEnd);
  return text.slice(0, hunk.theirsStart) + body + text.slice(hunk.theirsEnd);
}

export function replaceRange(text: string, start: number, end: number, value: string): string {
  return text.slice(0, start) + value + text.slice(end);
}

export function visibleBody(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function sideText(hunk: ConflictHunk, side: ConflictSide): string {
  if (side === "none") return "";
  if (side === "ours") return hunk.ours;
  if (side === "theirs") return hunk.theirs;
  if (!hunk.ours) return hunk.theirs;
  if (!hunk.theirs) return hunk.ours;
  const gap = hunk.ours.endsWith("\n") ? "" : "\n";
  return `${hunk.ours}${gap}${hunk.theirs}`;
}

function readHunk(text: string, from: number): ConflictHunk | null {
  const start = lineIndex(text, "<<<<<<<", from);
  if (start < 0) return null;
  const body = nextLine(text, start);
  if (body < 0) return null;
  const divider = lineIndex(text, "=======", body);
  if (divider < 0) return null;
  const baseAt = lineIndex(text, "|||||||", body);
  const hasBase = baseAt >= 0 && baseAt < divider;
  const oursEnd = hasBase ? baseAt : divider;
  const baseBody = hasBase ? nextLine(text, baseAt) : divider;
  const afterDivider = nextLine(text, divider);
  if (afterDivider < 0 || baseBody < 0) return null;
  const close = lineIndex(text, ">>>>>>>", afterDivider);
  if (close < 0) return null;
  const end = nextLine(text, close);
  return {
    ours: text.slice(body, oursEnd),
    theirs: text.slice(afterDivider, close),
    base: hasBase ? text.slice(baseBody, divider) : "",
    hasBase,
    start,
    end: end < 0 ? text.length : end,
    oursStart: body,
    oursEnd,
    theirsStart: afterDivider,
    theirsEnd: close,
  };
}

function lineIndex(text: string, prefix: string, from: number): number {
  let at = text.indexOf(prefix, from);
  while (at >= 0) {
    if (at === 0 || text[at - 1] === "\n") return at;
    at = text.indexOf(prefix, at + prefix.length);
  }
  return -1;
}

function nextLine(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  return nl < 0 ? -1 : nl + 1;
}
