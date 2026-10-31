export interface TextSpan {
  text: string;
  changed: boolean;
  tone?: "add" | "delete";
}

/** A syntax token within one line, by character offsets into the line's displayed text. */
export interface TokenRange {
  start: number;
  end: number;
  cls: string;
}

export interface StyledSpan extends TextSpan {
  cls: string | null;
}

/** Splits change spans at token boundaries so each piece carries both marks. */
export function styleSpans(spans: TextSpan[], ranges: TokenRange[] | null | undefined): StyledSpan[] {
  if (!ranges?.length) return spans.map((span) => ({ ...span, cls: null }));
  const out: StyledSpan[] = [];
  let offset = 0;
  let next = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    let cursor = offset;
    while (cursor < end) {
      while (next < ranges.length && ranges[next].end <= cursor) next += 1;
      const range = ranges[next];
      let stop = end;
      let cls: string | null = null;
      if (range && range.start <= cursor) {
        stop = Math.min(end, range.end);
        cls = range.cls;
      } else if (range && range.start < end) {
        stop = range.start;
      }
      out.push({ ...span, text: span.text.slice(cursor - offset, stop - offset), cls });
      cursor = stop;
    }
    offset = end;
  }
  return out;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  inl: "cpp",
  ipp: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  uproject: "json",
  uplugin: "json",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  lua: "lua",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  xaml: "markup",
  csproj: "markup",
  vcxproj: "markup",
  props: "markup",
  targets: "markup",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  bat: "batch",
  cmd: "batch",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  hlsl: "hlsl",
  usf: "hlsl",
  ush: "hlsl",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  cmake: "cmake",
};

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "ignore",
};

/**
 * The section heading on a hunk header.
 * `@@ -old,count +new,count @@` is git's range syntax; the line numbers are already in the gutter.
 */
export function hunkLabel(content: string): string {
  const text = content.replace(/[\r\n]+$/, "");
  const match = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[ \t]?(.*)$/.exec(text);
  return match ? match[1].trim() : text;
}

/** The Prism language for a path, or null when it has none worth highlighting. */
export function languageFor(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name] === "ignore" ? null : LANGUAGE_BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

export function diffLineSpans(lines: { kind: string; content: string }[]): TextSpan[][] {
  const spans = lines.map((line) => emphasizeWhitespace(line));
  let index = 0;
  while (index < lines.length) {
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
      } else {
        spans[index + pair] = changedSpans(removed, added);
        spans[deleteEnd + pair] = changedSpans(added, removed);
      }
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

function lineBreakOnly(content: string, other: string) {
  if (content.replace(/\r/g, "") !== other.replace(/\r/g, "")) return false;
  const internal = (value: string) => value.replace(/\r+$/g, "").includes("\r");
  return !internal(content) && !internal(other);
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
