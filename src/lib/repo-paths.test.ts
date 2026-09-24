import { describe, expect, it } from "vitest";
import { dirsToReload, repoRelative, touchesFile } from "./repo-paths";

const repo = "C:\\work\\Repo";

describe("repoRelative", () => {
  it("maps paths inside the repo and rejects the rest", () => {
    expect(repoRelative(repo, "c:/work/repo/Src/A.ts")).toBe("src/a.ts");
    expect(repoRelative(repo, "C:\\work\\Repo")).toBe("");
    expect(repoRelative(repo, "C:\\work\\RepoOther\\a.ts")).toBeNull();
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
