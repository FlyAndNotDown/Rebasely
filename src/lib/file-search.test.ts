import { describe, expect, it } from "vitest";
import { joinRoot, nestSearchNodes, type SearchNode } from "@/lib/file-search";

function names(nodes: SearchNode[] | undefined) {
  return (nodes ?? []).map((node) => node.relative.split("/").pop());
}

describe("nestSearchNodes", () => {
  it("shows a matching file under its parent folders and expands those folders", () => {
    const tree = nestSearchNodes([
      { relative: "client/src/notes.bat", dir: false, status: "current", detail: "Up to date" },
    ]);
    expect(names(tree.entries[""])).toEqual(["client"]);
    expect(names(tree.entries.client)).toEqual(["src"]);
    expect(names(tree.entries["client/src"])).toEqual(["notes.bat"]);
    expect(tree.entries["client/src"]?.[0]?.dir).toBe(false);
    expect(tree.open).toEqual(["client", "client/src"]);
  });

  it("keeps a matching folder collapsed until it has matching children", () => {
    const tree = nestSearchNodes([{ relative: ".cache", dir: true }]);
    expect(tree.entries[""]?.[0]).toMatchObject({ relative: ".cache", dir: true });
    expect(tree.open).toEqual([]);
  });

  it("opens a matching folder when a file inside it also matches", () => {
    const tree = nestSearchNodes([
      { relative: "src", dir: true },
      { relative: "src/app.ts", dir: false },
    ]);
    expect(names(tree.entries[""])).toEqual(["src"]);
    expect(names(tree.entries.src)).toEqual(["app.ts"]);
    expect(tree.open).toEqual(["src"]);
  });

  it("lists folders before files", () => {
    const tree = nestSearchNodes([
      { relative: "zeta.txt", dir: false },
      { relative: "alpha", dir: true },
    ]);
    expect(names(tree.entries[""])).toEqual(["alpha", "zeta.txt"]);
  });
});

describe("joinRoot", () => {
  it("joins a windows workspace root with a relative filter path", () => {
    expect(joinRoot("E:\\work\\client", "src/app.ts")).toBe("E:\\work\\client\\src\\app.ts");
    expect(joinRoot("E:\\work\\client", "")).toBe("E:\\work\\client");
  });
});
