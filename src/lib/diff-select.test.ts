import { describe, expect, it } from "vitest";
import { changeRange, hunkChanges, lineRefs, splitRows } from "./diff-select";
import type { DiffLine } from "@/types/git";

const line = (kind: string, oldLineno: number | null, newLineno: number | null): DiffLine => ({
  kind,
  content: "",
  oldLineno,
  newLineno,
});

const lines = [
  line("hunk", null, null),
  line("context", 1, 1),
  line("delete", 2, null),
  line("add", null, 2),
  line("context", 3, 3),
  line("hunk", null, null),
  line("add", null, 20),
];

describe("diff line selection", () => {
  it("groups changed lines under their hunk header", () => {
    expect([...hunkChanges(lines)]).toEqual([
      [0, [2, 3]],
      [5, [6]],
    ]);
  });

  it("selects only changed lines across a range in either direction", () => {
    expect(changeRange(lines, 6, 1)).toEqual([2, 3, 6]);
  });

  it("pairs removals with the additions after them for the split view", () => {
    const extra = [...lines, line("delete", 21, null), line("delete", 22, null), line("add", null, 21)];
    expect(splitRows(extra)).toEqual([
      { kind: "hunk", index: 0 },
      { kind: "pair", left: 1, right: 1 },
      { kind: "pair", left: 2, right: 3 },
      { kind: "pair", left: 4, right: 4 },
      { kind: "hunk", index: 5 },
      { kind: "pair", left: null, right: 6 },
      { kind: "pair", left: 7, right: 9 },
      { kind: "pair", left: 8, right: null },
    ]);
  });

  it("names additions by their new number and removals by their old one", () => {
    expect(lineRefs(lines, new Set([6, 2, 3, 1]))).toEqual([
      { old: 2, new: null },
      { old: null, new: 2 },
      { old: null, new: 20 },
    ]);
  });
});
