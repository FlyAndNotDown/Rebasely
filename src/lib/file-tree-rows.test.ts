import { describe, expect, it } from "vitest";
import { fileTreeRows, type TreeEntry } from "./file-tree-rows";

const entry = (path: string, dir = false): TreeEntry => ({ path, dir });

describe("fileTreeRows", () => {
  it("preserves listing order and depth while excluding collapsed descendants", () => {
    const entries = {
      "": [entry("src", true), entry("docs", true), entry("readme.md")],
      src: [entry("src/lib", true), entry("src/app.ts")],
      "src/lib": [entry("src/lib/path.ts")],
      docs: [entry("docs/guide.md")],
    };
    expect(fileTreeRows(entries, new Set(["src", "src/lib"]))).toEqual([
      { entry: entries[""][0], depth: 0 },
      { entry: entries.src[0], depth: 1 },
      { entry: entries["src/lib"][0], depth: 2 },
      { entry: entries.src[1], depth: 1 },
      { entry: entries[""][1], depth: 0 },
      { entry: entries[""][2], depth: 0 },
    ]);
  });

  it("does not read cached children of a collapsed large directory", () => {
    const entries = {
      "": [entry("build", true), entry("src", true)],
      get build(): TreeEntry[] {
        throw new Error("A collapsed directory must not be traversed");
      },
      src: [entry("src/app.ts")],
    };
    expect(fileTreeRows(entries, new Set(["src"])).map((row) => row.entry.path)).toEqual([
      "build", "src", "src/app.ts",
    ]);
  });

  it("supports a nested tree root and folders whose listing is still loading", () => {
    const entries = { depot: [entry("depot/new", true), entry("depot/file.txt")] };
    expect(fileTreeRows(entries, new Set(["depot/new"]), "depot", 2)).toEqual([
      { entry: entries.depot[0], depth: 2 },
      { entry: entries.depot[1], depth: 2 },
    ]);
  });

  it("handles deeply expanded trees without recursive calls", () => {
    const entries: Record<string, TreeEntry[]> = {};
    const open = new Set<string>();
    for (let index = 0; index < 15_000; index += 1) {
      const path = String(index);
      entries[index === 0 ? "" : String(index - 1)] = [entry(path, true)];
      open.add(path);
    }
    const rows = fileTreeRows(entries, open);
    expect(rows).toHaveLength(15_000);
    expect(rows.at(-1)?.depth).toBe(14_999);
  });
});
