import { describe, expect, it } from "vitest";
import { layoutCommitGraph } from "./commit-graph";

function assert(condition: boolean, message: string) {
  expect(condition, message).toBe(true);
}

function ids(...values: string[]) {
  return values;
}

function linear() {
  const rows = layoutCommitGraph([
    { id: "c", parents: ["b"] },
    { id: "b", parents: ["a"] },
    { id: "a", parents: [] },
  ]);
  assert(rows.every((row) => row.lane === 0), "linear history stays on lane 0");
  assert(rows.every((row) => row.merges.length === 0), "linear history has no merges");
  assert(rows[0].lines.some((line) => line.from === 0 && line.to === 0 && line.color === 0), "first parent continues on lane 0");
}

function mergeKeepsMainOnLeft() {
  // HEAD is the merge. Feature commits are newer than the mainline parent,
  // so they appear before the first-parent commit in date order.
  const rows = layoutCommitGraph([
    { id: "M", parents: ids("B", "F") },
    { id: "F", parents: ids("A") },
    { id: "B", parents: ids("A") },
    { id: "A", parents: [] },
  ]);

  assert(rows[0].lane === 0, "merge commit stays on the first-parent lane");
  assert(
    rows[0].lines.some((line) => line.from === 0 && line.to === 0 && line.color === 0),
    "first parent of the merge continues on lane 0",
  );
  assert(
    rows[0].lines.some((line) => line.from === 0 && line.to === 1 && line.color === 1),
    "second parent opens a new lane in that lane's color",
  );
  assert(rows[1].lane === 1, "feature tip occupies the side lane");
  assert(rows[2].lane === 0, "first-parent commit stays on lane 0");
  assert(
    !rows[2].lines.some((line) => line.from !== line.to),
    "first-parent commit must not steal the feature lane early",
  );
  assert(rows[3].lane === 0, "merge base sits on the leftmost reserved lane");
  assert(
    rows[3].merges.some((line) => line.from === 1 && line.to === 0 && line.color === 1),
    "side branch joins at the merge base in the side-branch color",
  );
}

function laterSideChildDoesNotStealMerge() {
  const rows = layoutCommitGraph([
    { id: "H", parents: ids("M") },
    { id: "S", parents: ids("M") },
    { id: "M", parents: ids("A") },
    { id: "A", parents: [] },
  ]);

  assert(rows[0].lane === 0, "HEAD stays on lane 0");
  assert(rows[1].lane === 1, "side child gets its own lane");
  assert(rows[2].lane === 0, "shared parent stays on the leftmost (main) lane");
  assert(
    rows[2].merges.some((line) => line.from === 1 && line.to === 0 && line.color === 1),
    "side child joins at the shared parent instead of pulling it onto the side lane",
  );
}

function mergeLineKeepsBranchColor() {
  const rows = layoutCommitGraph([
    { id: "H", parents: ids("M") },
    { id: "S", parents: ids("M") },
    { id: "Y", parents: ids("M") },
    { id: "M", parents: ids("A") },
    { id: "A", parents: [] },
  ]);

  assert(rows[3].lane === 0, "shared parent stays on main");
  const colors = rows[3].merges.map((line) => line.color).sort();
  assert(colors.join(",") === "1,2", "each joining branch keeps its own lane color");
}

function sideTipInterleavesByDate() {
  // Date order can place another branch's tip between two commits on main.
  const rows = layoutCommitGraph([
    { id: "D", parents: ids("C") },
    { id: "S", parents: ids("A") },
    { id: "C", parents: ids("B") },
    { id: "B", parents: ids("A") },
    { id: "A", parents: [] },
  ]);

  assert(rows[0].lane === 0, "main tip stays on lane 0");
  assert(rows[1].lane === 1, "side tip dated between main commits opens its own lane");
  assert(rows[2].lane === 0, "older main commit stays on lane 0");
  assert(
    rows[2].lines.some((line) => line.from === 0 && line.to === 0),
    "main rail continues through the interleaved side commit",
  );
  assert(rows[4].lane === 0, "shared ancestor stays on the main lane");
  assert(
    rows[4].merges.some((line) => line.from === 1 && line.to === 0),
    "side rail joins at the shared ancestor",
  );
}

describe("layoutCommitGraph", () => {
  it("keeps linear history on one lane", linear);
  it("keeps the mainline on the left through a merge", mergeKeepsMainOnLeft);
  it("does not let a later side child steal the merge", laterSideChildDoesNotStealMerge);
  it("keeps each joining branch's color", mergeLineKeepsBranchColor);
  it("interleaves a side tip by date", sideTipInterleavesByDate);
});
