/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { i18n } from "./index";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localeDirectory = path.join(root, "src/i18n/locales");

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[name, child]] : Object.entries(flatten(child as Record<string, unknown>, name));
  }));
}

function catalogs(language: string) {
  return Object.assign({}, ...readdirSync(localeDirectory).filter((name) => name === `${language}.json` || name.endsWith(`.${language}.json`)).map((name) => {
    const prefix = name === `${language}.json` ? "" : name.slice(0, -`.${language}.json`.length);
    return flatten(JSON.parse(readFileSync(path.join(localeDirectory, name), "utf8")), prefix);
  })) as Record<string, string>;
}

const english = catalogs("en");
const chinese = catalogs("zh-CN");
const placeholders = (value: string) => [...value.matchAll(/\{\{\s*-?\s*([\w.]+)/g)].map((match) => match[1]).sort();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : /\.(?:tsx?|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path.join(directory, entry.name)] : []);
}

const visibleAttributes = new Set(["label", "title", "description", "hint", "detail", "empty", "message", "group", "placeholder", "aria-label", "aria-description", "alt", "fallback", "missing", "emptyLabel", "loadingLabel", "buttonLabel", "action"]);
const technicalCopy = new Set(["Rebasely", "Git", "Perforce", "SSH", "GitHub", "GitLab", "PATH", "URL", "HEAD", "RSA", "RSA 4096", "ECDSA", "Ed25519", "v", "repo", "origin", "foo", "feature/name", "user_workspace", "fetch", "pull", "push", "utf8", "utf8-bom", "utf16", "utf16le", "utf16be", "utf32le", "utf32be", "yyyy/mm/dd:hh:mm:ss"]);

function meaningful(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return /[A-Za-z]/.test(text) && !technicalCopy.has(text) && !/^(?:https?:\/\/|ssl:|[A-Z]:\\|\/\/|[\w.+-]+@[\w.-]+\.[\w.-]+|v\d+\.\d+\.\d+$|stash@\{[ \d]*\}$)/.test(text);
}

function visibleLiteral(node: ts.Node): string | null {
  if (ts.isJsxText(node)) return meaningful(node.text) ? node.text.trim() : null;
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node)) return null;
  const text = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ") : node.text;
  if (!meaningful(text)) return null;
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isJsxAttribute(parent)) return visibleAttributes.has(parent.name.getText()) ? text : null;
    if (ts.isPropertyAssignment(parent)) return parent.name !== current && parent.name.getText() !== "action" && visibleAttributes.has(parent.name.getText().replace(/["']/g, "")) ? text : null;
    if (ts.isCallExpression(parent)) return /^(?:toast(?:\.(?:success|error|info|warning|message|loading))?|setError|setNotice|beginActivity)$/.test(parent.expression.getText()) ? text : null;
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === current || parent.whenFalse === current)) { current = parent; continue; }
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind) && parent.right === current) { current = parent; continue; }
    if (ts.isParenthesizedExpression(parent) || ts.isJsxExpression(parent)) { current = parent; continue; }
    if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) return text;
    break;
  }
  return null;
}

describe("localization coverage", () => {
  it("loads every catalog fragment into the runtime and keeps installer languages aligned", () => {
    for (const [language, catalog] of [["en", english], ["zh-CN", chinese]] as const) {
      for (const [key, value] of Object.entries(catalog)) expect(i18n.getResource(language, "translation", key), `${language}:${key}`).toBe(value);
    }
    const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
    expect(config.bundle.windows.nsis.languages).toEqual(["English", "SimpChinese"]);
    expect(config.bundle.windows.nsis.displayLanguageSelector).toBe(false);
  });
  it("keeps English and Chinese keys, interpolation values, and plural variants in parity", () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) {
      expect(value.trim(), key).not.toBe("");
      expect(chinese[key]?.trim(), key).not.toBe("");
      expect(placeholders(chinese[key]), key).toEqual(placeholders(value));
      expect(value + chinese[key], key).not.toMatch(/\uFFFD/);
      if (key.endsWith("_one")) expect(english[key.replace(/_one$/, "_other")], key).toBeDefined();
    }
  });

  it("resolves literal translation keys and rejects untranslated UI copy", () => {
    const failures: string[] = [];
    for (const filename of sourceFiles(path.join(root, "src"))) {
      const relative = path.relative(root, filename).replace(/\\/g, "/");
      const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      function visit(node: ts.Node) {
        const location = `${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const visible = visibleLiteral(node);
        if (visible) failures.push(`${location}: move UI copy to a translation resource: ${visible}`);
        if (ts.isCallExpression(node) && node.expression.getText(source) === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const key = node.arguments[0].text;
          if (!(key in english) && !(`${key}_other` in english)) failures.push(`${location}: missing translation key ${key}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
