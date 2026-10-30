import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkVersions, compareVersions, parseReleaseTag, setVersion, validateReleaseVersion } from "./release-version.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(version = "0.0.1") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rebasely-version-"));
  directories.push(directory);
  await mkdir(path.join(directory, "src-tauri"));
  const files = {
    "package.json": JSON.stringify({ name: "rebasely", version, dependencies: { library: "2.0.0" } }),
    "package-lock.json": JSON.stringify({ name: "rebasely", version, packages: { "": { name: "rebasely", version }, "node_modules/library": { version: "2.0.0" } } }),
    "src-tauri/tauri.conf.json": JSON.stringify({ version, bundle: { createUpdaterArtifacts: true } }),
    "src-tauri/Cargo.toml": `[package]\nname = "rebasely"\nversion = "${version}"\n\n[dependencies]\nother = "4.0.0"\n`,
    "src-tauri/Cargo.lock": `version = 4\n\n[[package]]\nname = "other"\nversion = "4.0.0"\n\n[[package]]\nname = "rebasely"\nversion = "${version}"\ndependencies = ["other"]\n\n[[package]]\nname = "third"\nversion = "3.0.0"\n`,
  };
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(path.join(directory, name), contents)));
  return directory;
}

describe("release versions", () => {
  it("requires a canonical stable v-prefixed version that installers can represent", () => {
    expect(parseReleaseTag("v0.0.1")).toBe("0.0.1");
    expect(parseReleaseTag("v65535.65535.65535")).toBe("65535.65535.65535");
    for (const value of ["0.0.1", "v01.0.0", "v1.0", "v1.0.0-beta.1", "v1.0.0+build", "v1.0.0\n", " v1.0.0", "v1.0.0 && command", "v65536.0.0"]) {
      expect(() => parseReleaseTag(value)).toThrow();
    }
  });

  it("orders components numerically and permits the first checked-in version", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("0.0.1", "0.0.1")).toBe(0);
    expect(validateReleaseVersion("v0.0.1", "0.0.1", [])).toBe("0.0.1");
    expect(validateReleaseVersion("v0.1.0", "0.0.1", ["v0.0.9", "unrelated-tag", "v01.0.0"])).toBe("0.1.0");
    expect(() => validateReleaseVersion("v0.0.1", "0.0.1", ["v0.0.1"])).toThrow("already exists");
    expect(() => validateReleaseVersion("v0.0.2", "0.0.1", ["v0.0.3"])).toThrow("must be newer");
    expect(() => validateReleaseVersion("v0.0.1", "0.0.2", [])).toThrow("older than the source");
  });

  it("stamps every application version while preserving dependency versions", async () => {
    const directory = await fixture();
    expect(await checkVersions(directory)).toBe("0.0.1");
    expect(await setVersion("v1.2.3", directory)).toBe("1.2.3");
    const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.dependencies.library).toBe("2.0.0");
    expect(lock.packages[""].version).toBe("1.2.3");
    expect(lock.packages["node_modules/library"].version).toBe("2.0.0");
    const cargo = await readFile(path.join(directory, "src-tauri/Cargo.toml"), "utf8");
    const cargoLock = await readFile(path.join(directory, "src-tauri/Cargo.lock"), "utf8");
    expect(cargo).toContain('version = "1.2.3"');
    expect(cargo).toContain('other = "4.0.0"');
    expect(cargoLock).toContain('name = "other"\nversion = "4.0.0"');
    expect(cargoLock).toContain('name = "third"\nversion = "3.0.0"');
    expect(() => validateReleaseVersion("v0.0.1", "1.2.3", [])).toThrow();
  });

  it("refuses inconsistent inputs before changing any files", async () => {
    const directory = await fixture();
    const pkgPath = path.join(directory, "package.json");
    const before = await readFile(pkgPath, "utf8");
    await writeFile(path.join(directory, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.0.2" }));
    await expect(checkVersions(directory)).rejects.toThrow("Version mismatch");
    await expect(setVersion("v1.0.0", directory)).rejects.toThrow("Version mismatch");
    expect(await readFile(pkgPath, "utf8")).toBe(before);
  });

  it("rejects downgrades and ambiguous Cargo package sections", async () => {
    const directory = await fixture("1.0.0");
    await expect(setVersion("v0.9.0", directory)).rejects.toThrow("decrease");
    const filename = path.join(directory, "src-tauri/Cargo.lock");
    await writeFile(filename, `${await readFile(filename, "utf8")}\n[[package]]\nname = "rebasely"\nversion = "1.0.0"\n`);
    await expect(setVersion("v2.0.0", directory)).rejects.toThrow("Expected one");
  });
});
