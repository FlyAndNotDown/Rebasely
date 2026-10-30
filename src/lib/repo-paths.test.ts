import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathsIgnoreCase } from "./format";
import { dirsToReload, repoRelative, touchesFile } from "./repo-paths";

const repo = "C:\\work\\Repo";

beforeEach(() => vi.stubGlobal("navigator", { userAgent: "Windows" }));
afterEach(() => vi.unstubAllGlobals());

describe("repoRelative", () => {
  it("maps paths inside the repo and rejects the rest", () => {
    expect(repoRelative(repo, "c:/work/repo/Src/A.ts")).toBe(pathsIgnoreCase() ? "src/a.ts" : null);
    expect(repoRelative(repo, "C:\\work\\Repo\\Src\\A.ts")).toBe(pathsIgnoreCase() ? "src/a.ts" : "Src/A.ts");
    expect(repoRelative(repo, "C:\\work\\Repo")).toBe("");
    expect(repoRelative(repo, "C:\\work\\RepoOther\\a.ts")).toBeNull();
  });

  it("keeps POSIX backslashes as file-name characters and respects case", () => {
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    expect(repoRelative("/work/Repo", "/work/Repo/src/a\\b.ts")).toBe("src/a\\b.ts");
    expect(repoRelative("/work/Repo", "/work/repo/src/a.ts")).toBeNull();
    expect(repoRelative("/", "/file.txt")).toBe("file.txt");
    expect(touchesFile("/work/Repo", ["/work/Repo/.git/HEAD"], "src/a\\b.ts")).toBe(true);
  });
});

describe("dirsToReload", () => {
  const loaded = ["", "Src", "Src/Nested"];

  it("reloads only the expanded parent of each changed path", () => {
    expect(dirsToReload(repo, ["C:\\work\\Repo\\Src\\new.ts"], loaded)).toEqual(["Src"]);
    expect(dirsToReload(repo, ["C:\\work\\Repo\\top.txt"], loaded)).toEqual([""]);
    expect(dirsToReload(repo, ["C:\\work\\Repo\\Collapsed\\x.ts"], loaded)).toEqual([]);
  });

  it("ignores .git internals and reloads everything when the watcher overflowed", () => {
    expect(dirsToReload(repo, ["C:\\work\\Repo\\.git\\index"], loaded)).toEqual([]);
    expect(dirsToReload(repo, null, loaded)).toEqual(loaded);
  });
});

describe("touchesFile", () => {
  it("is true for the file itself or a HEAD, ref, or index change", () => {
    expect(touchesFile(repo, ["C:\\work\\Repo\\src\\a.ts"], "src/a.ts")).toBe(true);
    expect(touchesFile(repo, ["C:\\work\\Repo\\.git\\HEAD"], "src/a.ts")).toBe(true);
    expect(touchesFile(repo, ["C:\\work\\Repo\\src\\b.ts"], "src/a.ts")).toBe(false);
    expect(touchesFile(repo, null, "src/a.ts")).toBe(true);
  });
});
