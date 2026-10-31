import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateSiteDocument } from "./site-document.mjs";

const root = fileURLToPath(new URL("../site/dist/", import.meta.url));
const files = new Set();
const textFiles = new Map();
const violations = [];

async function collect(directory = "") {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const filename = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) violations.push(`${filename}: Pages assets must not use symbolic links`);
    else if (entry.isDirectory()) await collect(filename);
    else if (entry.isFile()) files.add(filename);
  }
}

try {
  await collect();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.error("Website output is missing; run npm run site:build first.");
  process.exit(1);
}
if (!files.has("index.html")) violations.push("index.html: missing website entry point");

for (const filename of files) {
  if (/\.(?:html|css|svg)$/.test(filename)) {
    textFiles.set(filename, await readFile(path.join(root, filename), "utf8"));
  }
  if (/\.(?:mjs|js)$/.test(filename)) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, filename)], { encoding: "utf8" });
    if (result.error || result.status !== 0) violations.push(`${filename}: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

for (const [filename, content] of textFiles) {
  const references = /\.css$/.test(filename)
    ? [...content.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)].map((match) => match[1])
    : [...content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  for (const reference of references) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) continue;
    if (reference.startsWith("/")) {
      violations.push(`${filename}: use a relative URL for project Pages: ${reference}`);
      continue;
    }
    let target;
    let linkedPath;
    let id;
    try {
      target = new URL(reference, `https://site.invalid/${filename}`);
      linkedPath = decodeURIComponent(target.pathname);
      id = decodeURIComponent(target.hash.slice(1));
    } catch {
      violations.push(`${filename}: invalid local URL: ${reference}`);
      continue;
    }
    const linkedFile = linkedPath.slice(1) + (linkedPath.endsWith("/") ? "index.html" : "");
    if (!files.has(linkedFile)) {
      violations.push(`${filename}: missing local asset or page: ${reference}`);
      continue;
    }
    if (target.hash && linkedFile.endsWith(".html")) {
      const ids = [...textFiles.get(linkedFile).matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
      if (!ids.includes(id)) violations.push(`${filename}: missing anchor: ${reference}`);
    }
  }
}

const sitemap = files.has("sitemap.xml") ? await readFile(path.join(root, "sitemap.xml"), "utf8") : "";
for (const filename of ["index.html", "en/index.html", "zh-CN/index.html"]) {
  if (!files.has(filename)) violations.push(`${filename}: missing crawlable language page`);
  violations.push(...validateSiteDocument({ html: textFiles.get(filename) ?? "", sitemap, files, filename }));
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Website checks passed for ${files.size} files.`);
}
