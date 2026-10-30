import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensions = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html", ".json", ".toml", ".yml", ".yaml", ".svg", ".md", ".lock"]);
const directories = ["src", "src-tauri/src", "src-tauri/capabilities", "scripts", ".github", "docs", "site"];
const files = [];
const violations = [];
const han = /\p{Script=Han}/u;

async function collect(directory, recursive) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) await collect(target, true);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(target);
  }
}

await collect(root, false);
await collect(path.join(root, "src-tauri"), false);
for (const directory of directories) await collect(path.join(root, directory), true);

for (const filename of files.sort()) {
  const relative = path.relative(root, filename).replaceAll("\\", "/");
  if (han.test(relative)) violations.push(`${relative}: source file names must use English`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filename));
  } catch {
    violations.push(`${relative}: source text must use UTF-8`);
    continue;
  }
  for (const [index, line] of text.split("\n").entries()) {
    if (han.test(line)) violations.push(`${relative}:${index + 1}: source text must use English`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Source policy passed for ${files.length} text files.`);
}
