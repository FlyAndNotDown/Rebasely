import Prism from "prismjs";
// Order matters: each grammar extends the ones imported before it.
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-batch";
import "prismjs/components/prism-glsl";
import "prismjs/components/prism-hlsl";
import "prismjs/components/prism-protobuf";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-cmake";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-docker";
import type { TokenRange } from "@/lib/diff-text";

/** Prism token types folded into the handful of colors the theme defines. */
const TOKEN_CLASS: Record<string, string> = {
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "comment",
  string: "string",
  char: "string",
  "template-string": "string",
  "attr-value": "string",
  url: "string",
  regex: "regex",
  keyword: "keyword",
  important: "keyword",
  atrule: "keyword",
  directive: "keyword",
  macro: "keyword",
  boolean: "constant",
  constant: "constant",
  symbol: "constant",
  entity: "constant",
  number: "number",
  function: "function",
  "function-definition": "function",
  "class-name": "type",
  builtin: "type",
  namespace: "type",
  property: "property",
  "attr-name": "property",
  key: "property",
  tag: "tag",
  selector: "tag",
  variable: "variable",
  parameter: "variable",
  operator: "operator",
  punctuation: "punct",
};

/** Long minified lines can make Prism's regexes crawl. */
const MAX_LINE = 2000;
const MAX_TOTAL = 400_000;

type Flat = { text: string; cls: string | null };

function tokenClass(token: Prism.Token): string | null {
  const direct = TOKEN_CLASS[token.type];
  if (direct) return direct;
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  for (const alias of aliases) {
    if (TOKEN_CLASS[alias]) return TOKEN_CLASS[alias];
  }
  return null;
}

function flatten(stream: Prism.TokenStream, inherited: string | null, out: Flat[]) {
  if (typeof stream === "string") {
    out.push({ text: stream, cls: inherited });
    return;
  }
  if (Array.isArray(stream)) {
    for (const item of stream) flatten(item, inherited, out);
    return;
  }
  flatten(stream.content, tokenClass(stream) ?? inherited, out);
}

function withinLimits(lines: string[]): boolean {
  let total = 0;
  for (const line of lines) {
    if (line.length > MAX_LINE) return false;
    total += line.length;
    if (total > MAX_TOTAL) return false;
  }
  return true;
}

/** Tokenizes consecutive lines as one block and returns ranges per line. */
function tokenizeBlock(texts: string[], grammar: Prism.Grammar): TokenRange[][] {
  const out: TokenRange[][] = texts.map(() => []);
  const flat: Flat[] = [];
  flatten(Prism.tokenize(texts.join("\n"), grammar), null, flat);
  let line = 0;
  let column = 0;
  for (const piece of flat) {
    const parts = piece.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        line += 1;
        column = 0;
      }
      if (part && piece.cls && line < out.length) {
        out[line].push({ start: column, end: column + part.length, cls: piece.cls });
      }
      column += part.length;
    });
  }
  return out;
}

/** Syntax ranges for a whole file, or null when the language is unknown or the text is too large. */
export function highlightText(lines: string[], language: string): TokenRange[][] | null {
  const grammar = Prism.languages[language];
  if (!grammar || !withinLimits(lines)) return null;
  return tokenizeBlock(lines, grammar);
}

/**
 * Syntax ranges for every line of a diff, or null when the language is
 * unknown. Each hunk's old side (context and removals) and new side (context
 * and additions) are tokenized as whole blocks, so comments and strings that
 * span lines stay colored; context lines take their colors from the new side.
 */
export function highlightDiff(
  lines: { kind: string; text: string }[],
  language: string,
): TokenRange[][] | null {
  const grammar = Prism.languages[language];
  if (!grammar || !withinLimits(lines.map((line) => line.text))) return null;

  const result: TokenRange[][] = lines.map(() => []);
  let oldSide: number[] = [];
  let newSide: number[] = [];
  const flush = () => {
    const oldRanges = tokenizeBlock(oldSide.map((index) => lines[index].text), grammar);
    oldSide.forEach((index, position) => {
      if (lines[index].kind === "delete") result[index] = oldRanges[position];
    });
    const newRanges = tokenizeBlock(newSide.map((index) => lines[index].text), grammar);
    newSide.forEach((index, position) => {
      result[index] = newRanges[position];
    });
    oldSide = [];
    newSide = [];
  };
  lines.forEach((line, index) => {
    if (line.kind === "hunk") {
      flush();
    } else if (line.kind === "delete") {
      oldSide.push(index);
    } else if (line.kind === "add") {
      newSide.push(index);
    } else {
      oldSide.push(index);
      newSide.push(index);
    }
  });
  flush();
  return result;
}
