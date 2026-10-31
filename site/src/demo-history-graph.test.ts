import { describe, expect, it } from "vitest";
import { demoCommits } from "./demo-data";
import { DEMO_GRAPH_ROW_HEIGHT, demoGraphSegments, demoGraphWidth, demoGraphX, layoutDemoHistoryGraph } from "./demo-history-graph";

describe("demo history graph", () => {
  it("keeps both rails continuous through the feature commit and closes at its real parent", () => {
    const rows = layoutDemoHistoryGraph(demoCommits);
    const mid = DEMO_GRAPH_ROW_HEIGHT / 2;
    const mainX = demoGraphX(0);
    const sideX = demoGraphX(1);
    expect(rows[2].lane).toBe(1);
    expect(demoGraphSegments(rows[2], rows[1])).toContainEqual({
      from: { x: mainX, y: mid },
      to: { x: mainX, y: DEMO_GRAPH_ROW_HEIGHT },
      color: 0,
    });
    expect(demoGraphSegments(rows[3], rows[2])).toContainEqual({
      from: { x: sideX, y: 0 },
      to: { x: mainX, y: mid },
      color: 1,
    });
    for (let index = 0; index < rows.length - 1; index += 1) {
      const outgoing = demoGraphSegments(rows[index], rows[index - 1])
        .filter((segment) => segment.to.y === DEMO_GRAPH_ROW_HEIGHT)
        .map((segment) => `${segment.to.x}:${segment.color}`).sort();
      const incoming = demoGraphSegments(rows[index + 1], rows[index])
        .filter((segment) => segment.from.y === 0)
        .map((segment) => `${segment.from.x}:${segment.color}`).sort();
      expect(incoming).toEqual(outgoing);
    }
    expect(demoGraphSegments(rows[0]).every((segment) => segment.from.y === mid)).toBe(true);
    expect(demoGraphSegments(rows.at(-1)!, rows.at(-2)).every((segment) => segment.to.y === mid)).toBe(true);
  });

  it("extends the mainline for new commits without moving the existing feature lane", () => {
    const original = layoutDemoHistoryGraph(demoCommits);
    const prepended = layoutDemoHistoryGraph([
      { hash: "newer", parents: ["new"] },
      { hash: "new", parents: [demoCommits[0].hash] },
      ...demoCommits,
    ]);
    expect(prepended.slice(2)).toEqual(original);
    expect(prepended.slice(0, 2).every((row) => row.lane === 0 && row.lines.length === 1)).toBe(true);
    expect(demoGraphWidth(prepended)).toBe(demoGraphWidth(original));
  });

  it("does not connect search matches through hidden intermediate commits", () => {
    const commits = [
      { hash: "tip", parents: ["hidden"] },
      { hash: "hidden", parents: ["base"] },
      { hash: "base", parents: [] },
    ];
    const filtered = layoutDemoHistoryGraph(commits.filter((commit) => commit.hash !== "hidden"));
    expect(filtered.every((row) => row.lines.length === 0 && row.merges.length === 0)).toBe(true);
    expect(layoutDemoHistoryGraph([])).toEqual([]);
  });

  it("retains real parent links between visible matches without dangling hidden branches", () => {
    const rows = layoutDemoHistoryGraph(demoCommits.filter((commit) => commit.hash === "9e72bc1" || commit.hash === "c4d810a"));
    expect(rows[0].lines).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[1].lines).toEqual([]);
    expect(rows.every((row) => row.merges.length === 0)).toBe(true);
  });
});
