import { describe, expect, it } from "vitest";
import {
  buildChangeTree,
  changeRows,
  ignoreExtensionPattern,
  ignorePathPattern,
  rangeBetween,
} from "./change-tree";
import type { FileStatus } from "@/types/git";

const file = (path: string): FileStatus => ({ path, oldPath: null, kind: "modified", staged: false });

describe("buildChangeTree", () => {
  it("sorts folders before files and joins single-folder chains", () => {
    const tree = buildChangeTree([
      file("src/lib/deep/only.ts"),
      file("src/b.ts"),
      file("README.md"),
      file("src/A.ts"),
      file("docs/guide.md"),
    ]);
    expect(tree.dirs.map((dir) => dir.label)).toEqual(["docs", "src"]);
    expect(tree.files.map((item) => item.path)).toEqual(["README.md"]);
    const src = tree.dirs[1];
    expect(src.dirs.map((dir) => [dir.label, dir.path])).toEqual([["lib/deep", "src/lib/deep"]]);
    expect(src.files.map((item) => item.path)).toEqual(["src/A.ts", "src/b.ts"]);
  });

  it("sorts numbered names naturally and preserves the order of case-equivalent names", () => {
    const tree = buildChangeTree([
      file("folder10/file.txt"),
      file("folder2/item10.txt"),
      file("folder2/item2.txt"),
      file("folder2/ITEM2.txt"),
      file("folder1/file.txt"),
    ]);
    expect(tree.dirs.map((dir) => dir.label)).toEqual(["folder1", "folder2", "folder10"]);
    expect(tree.dirs[1].files.map((item) => item.path)).toEqual([
      "folder2/item2.txt",
      "folder2/ITEM2.txt",
      "folder2/item10.txt",
    ]);
  });
});

describe("changeRows", () => {
  const files = [file("a/x.ts"), file("a/y.ts"), file("b/z.ts"), file("top.ts")];

  it("lists files flat outside tree mode", () => {
    expect(changeRows("unstaged", files, false, new Set()).map((row) => row.kind)).toEqual([
      "file",
      "file",
      "file",
      "file",
    ]);
  });

  it("nests files under folders and hides collapsed folders", () => {
    const rows = changeRows("staged", files, true, new Set(["staged:a"]));
    expect(
      rows.map((row) => (row.kind === "dir" ? `dir:${row.path}:${row.open}` : row.file.path)),
    ).toEqual(["dir:a:false", "dir:b:true", "b/z.ts", "top.ts"]);
    const folder = rows[0];
    expect(folder.kind === "dir" && folder.paths).toEqual(["a/x.ts", "a/y.ts"]);
  });
});

describe("ignore patterns", () => {
  it("anchors paths and escapes glob characters", () => {
    expect(ignorePathPattern("build/out.log")).toBe("/build/out.log");
    expect(ignorePathPattern("Saved", true)).toBe("/Saved/");
    expect(ignorePathPattern("odd[1]*?.txt")).toBe("/odd\\[1]\\*\\?.txt");
    expect(ignorePathPattern("trailing ")).toBe("/trailing\\ ");
  });

  it("matches by extension only when the name has one", () => {
    expect(ignoreExtensionPattern("logs/app.log")).toBe("*.log");
    expect(ignoreExtensionPattern("Makefile")).toBeNull();
    expect(ignoreExtensionPattern(".env")).toBeNull();
    expect(ignoreExtensionPattern("dir/name.")).toBeNull();
  });
});

describe("rangeBetween", () => {
  const order = ["a", "b", "c", "d"];

  it("covers both directions and falls back to the target alone", () => {
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, null, "c")).toEqual(["c"]);
    expect(rangeBetween(order, "zz", "c")).toEqual(["c"]);
    expect(rangeBetween(order, "a", "zz")).toEqual([]);
  });
});
