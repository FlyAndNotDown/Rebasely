import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || tag.length > 18 || tag !== tag.trim()
    || !tag.startsWith("v") || !versionPattern.test(tag.slice(1))) {
    throw new Error("Enter a stable release version in vX.Y.Z format, without leading zeros.");
  }
  const version = tag.slice(1);
  if (version.split(".").some((part) => BigInt(part) > 65535n)) {
    throw new Error("Each release version component must be at most 65535 for Windows installers.");
  }
  return version;
}

export function compareVersions(left, right) {
  const a = parseReleaseTag(`v${left}`).split(".").map(Number);
  const b = parseReleaseTag(`v${right}`).split(".").map(Number);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function validateReleaseVersion(tag, sourceVersion, existingTags) {
  const version = parseReleaseTag(tag);
  if (compareVersions(version, sourceVersion) < 0) {
    throw new Error(`Release ${tag} is older than the source version v${sourceVersion}.`);
  }
  for (const existing of existingTags) {
    if (existing === tag) throw new Error(`Release tag ${tag} already exists or is reserved by a draft.`);
    let existingVersion;
    try {
      existingVersion = parseReleaseTag(existing);
    } catch {
      continue;
    }
    if (compareVersions(version, existingVersion) <= 0) {
      throw new Error(`Release ${tag} must be newer than ${existing}.`);
    }
  }
  return version;
}

function cargoPackage(text, array) {
  const header = array ? "[[package]]" : "[package]";
  const sections = [...text.matchAll(/^\[.*\][ \t]*\r?$/gm)];
  const matches = sections.flatMap((section, index) => {
    if (section[0].trimEnd() !== header) return [];
    const start = section.index;
    const end = sections[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    if (!/^name[ \t]*=[ \t]*"rebasely"[ \t]*\r?$/m.test(block)) return [];
    const version = block.match(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*\r?$/m);
    if (!version) throw new Error(`Missing Rebasely version in Cargo ${header} section.`);
    return [{ start, end, block, version: version[1] }];
  });
  if (matches.length !== 1) throw new Error(`Expected one Rebasely Cargo ${header} section.`);
  return matches[0];
}

async function readManifests(directory) {
  const filenames = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
  const texts = await Promise.all(filenames.map((name) => readFile(path.join(directory, name), "utf8")));
  const [pkg, lock, tauri] = texts.slice(0, 3).map((text) => JSON.parse(text));
  const cargo = cargoPackage(texts[3], false);
  const cargoLock = cargoPackage(texts[4], true);
  const versions = [pkg.version, lock.version, lock.packages?.[""]?.version, tauri.version, cargo.version, cargoLock.version];
  const version = parseReleaseTag(`v${versions[0]}`);
  if (versions.some((value) => value !== version)) {
    throw new Error("Version mismatch between package.json, package-lock.json, tauri.conf.json, Cargo.toml, and Cargo.lock.");
  }
  return { filenames, texts, pkg, lock, tauri, cargo, cargoLock, version };
}

export async function checkVersions(directory = root) {
  return (await readManifests(directory)).version;
}

export async function setVersion(tag, directory = root) {
  const files = await readManifests(directory);
  const version = parseReleaseTag(tag);
  if (compareVersions(version, files.version) < 0) throw new Error("A release cannot decrease the source version.");
  files.pkg.version = version;
  files.lock.version = version;
  files.lock.packages[""].version = version;
  files.tauri.version = version;
  const replaceCargo = (text, section) => text.slice(0, section.start)
    + section.block.replace(/^(version[ \t]*=[ \t]*")[^"]+("[ \t]*\r?)$/m, (_match, before, after) => `${before}${version}${after}`)
    + text.slice(section.end);
  const texts = [
    ...[files.pkg, files.lock, files.tauri].map((value) => `${JSON.stringify(value, null, 2)}\n`),
    replaceCargo(files.texts[3], files.cargo),
    replaceCargo(files.texts[4], files.cargoLock),
  ];
  for (const [index, filename] of files.filenames.entries()) {
    if (texts[index] !== files.texts[index]) await writeFile(path.join(directory, filename), texts[index], "utf8");
  }
  return checkVersions(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, tag, ...extra] = process.argv.slice(2);
    if (extra.length || (command !== "check" && command !== "set") || (command === "check" && tag) || (command === "set" && !tag)) {
      throw new Error("Usage: node scripts/release-version.mjs check | set vX.Y.Z");
    }
    const version = command === "set" ? await setVersion(tag) : await checkVersions();
    console.log(`Version files agree on v${version}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
