export interface TextSpan {
  text: string;
  changed: boolean;
  tone?: "add" | "delete";
}

export function diffLineSpans(lines: { kind: string; content: string }[]): TextSpan[][] {
  const spans = lines.map((line) => emphasizeWhitespace(line));
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind === "add") {
      if (isBlank(lines[index].content)) highlightAfterBreak(lines, spans, index, "add");
      index += 1;
      continue;
    }
    if (lines[index].kind !== "delete") {
      index += 1;
      continue;
    }
    let deleteEnd = index;
    while (deleteEnd < lines.length && lines[deleteEnd].kind === "delete") deleteEnd += 1;
    let addEnd = deleteEnd;
    while (addEnd < lines.length && lines[addEnd].kind === "add") addEnd += 1;
    const deleteCount = deleteEnd - index;
    const addCount = addEnd - deleteEnd;
    const pairs = Math.min(deleteCount, addCount);
    for (let pair = 0; pair < pairs; pair += 1) {
      const removed = lines[index + pair].content;
      const added = lines[deleteEnd + pair].content;
      if (lineBreakOnly(removed, added)) {
        spans[index + pair] = unchanged(removed.replace(/\r/g, ""));
        spans[deleteEnd + pair] = unchanged(added.replace(/\r/g, ""));
        const tone = added.includes("\r") && !removed.includes("\r") ? "add" : "delete";
        highlightAfterBreak(lines, spans, deleteEnd + pair, tone);
      } else {
        spans[index + pair] = changedSpans(removed, added);
        spans[deleteEnd + pair] = changedSpans(added, removed);
      }
    }
    for (let extra = pairs; extra < deleteCount; extra += 1) {
      const at = index + extra;
      if (isBlank(lines[at].content)) highlightAfterBreak(lines, spans, at, "delete");
    }
    for (let extra = pairs; extra < addCount; extra += 1) {
      const at = deleteEnd + extra;
      if (isBlank(lines[at].content)) highlightAfterBreak(lines, spans, at, "add");
    }
    index = addEnd;
  }
  return spans.map((row) => revealReturns(row));
}

function emphasizeWhitespace(line: { kind: string; content: string }): TextSpan[] {
  if (line.kind !== "add" && line.kind !== "delete") return unchanged(line.content);
  const cr = line.content.endsWith("\r");
  const content = cr ? line.content.slice(0, -1) : line.content;
  const ending: TextSpan[] = cr ? [{ text: "\r", changed: false }] : [];
  if (/^[ \t]+$/.test(content)) return [{ text: content, changed: true }, ...ending];
  const trailing = content.match(/[ \t]+$/);
  if (!trailing || trailing.index === undefined) return [...unchanged(content), ...ending];
  return [
    { text: content.slice(0, trailing.index), changed: false },
    { text: trailing[0], changed: true },
    ...ending,
  ];
}

function unchanged(content: string): TextSpan[] {
  return content ? [{ text: content, changed: false }] : [];
}

function changedSpans(content: string, other: string): TextSpan[] {
  if (content === other) return unchanged(content);
  let start = 0;
  const limit = Math.min(content.length, other.length);
  while (start < limit && content[start] === other[start]) start += 1;
  let end = content.length;
  let otherEnd = other.length;
  while (end > start && otherEnd > start && content[end - 1] === other[otherEnd - 1]) {
    end -= 1;
    otherEnd -= 1;
  }
  const parts: TextSpan[] = [];
  if (start > 0) parts.push({ text: content.slice(0, start), changed: false });
  if (end > start) parts.push({ text: content.slice(start, end), changed: true });
  if (end < content.length) parts.push({ text: content.slice(end), changed: false });
  return parts;
}

function isBlank(content: string) {
  return content.replace(/[ \t\r]/g, "").length === 0;
}

function lineBreakOnly(content: string, other: string) {
  if (content.replace(/\r/g, "") !== other.replace(/\r/g, "")) return false;
  const internal = (value: string) => value.replace(/\r+$/g, "").includes("\r");
  return !internal(content) && !internal(other);
}

function highlightAfterBreak(
  lines: { kind: string; content: string }[],
  spans: TextSpan[][],
  breakIndex: number,
  tone: "add" | "delete",
) {
  spans[breakIndex] = unchanged(lines[breakIndex].content.replace(/\r/g, ""));
  const next = breakIndex + 1;
  if (next >= lines.length || lines[next].kind === "hunk") return;
  if (spans[next].some((span) => span.changed)) return;
  const text = lines[next].content.replace(/\r/g, "");
  const lead = text.match(/^[ \t]*/)?.[0].length ?? 0;
  const body = text.slice(lead);
  if (!body) return;
  const marked: TextSpan[] = [];
  if (lead > 0) marked.push({ text: text.slice(0, lead), changed: false });
  marked.push({ text: body, changed: true, tone });
  spans[next] = marked;
}

/** Approximate monospace width: tabs expand to the next stop of 4, wide CJK characters take two cells. */
export function textColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === "\t") columns += 4 - (columns % 4);
    else if (char === "\r") continue;
    else columns += (char.codePointAt(0) ?? 0) >= 0x1100 && isWide(char) ? 2 : 1;
  }
  return columns;
}

function isWide(char: string) {
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(
    char,
  );
}

function revealReturns(row: TextSpan[]): TextSpan[] {
  let after = false;
  const out: TextSpan[] = [];
  for (const span of row) {
    const parts = span.text.split("\r");
    parts.forEach((part, partIndex) => {
      if (partIndex > 0 && span.changed) after = true;
      if (!part) return;
      out.push({ text: part, changed: span.changed || after, tone: span.tone });
    });
  }
  return out;
}
