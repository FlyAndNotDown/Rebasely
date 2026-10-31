import { layoutCommitGraph, type GraphRow } from "@/lib/commit-graph";

export const DEMO_GRAPH_ROW_HEIGHT = 28;
const LANE_GAP = 16;

interface Point {
  x: number;
  y: number;
}

export interface DemoGraphSegment {
  from: Point;
  to: Point;
  color: number;
}

export function layoutDemoHistoryGraph(commits: readonly { hash: string; parents: readonly string[] }[]): GraphRow[] {
  const visible = new Set(commits.map((commit) => commit.hash));
  // Search results only connect real parent pairs. Hidden ancestors must not
  // turn two matching commits into an invented direct-parent relationship.
  return layoutCommitGraph(commits.map((commit) => ({
    id: commit.hash,
    parents: commit.parents.filter((parent) => visible.has(parent)),
  })));
}

export function demoGraphX(lane: number): number {
  return 12 + lane * LANE_GAP;
}

export function demoGraphWidth(rows: readonly GraphRow[]): number {
  return Math.max(2, ...rows.map((row) => row.laneCount)) * LANE_GAP + 16;
}

export function demoGraphSegments(row: GraphRow, previous?: GraphRow): DemoGraphSegment[] {
  const mid = DEMO_GRAPH_ROW_HEIGHT / 2;
  const merging = new Set(row.merges.map((line) => line.from));
  const incoming = new Map(previous?.lines.map((line) => [line.to, line]));
  return [
    ...[...incoming.values()].filter((line) => !merging.has(line.to)).map((line) => ({
      from: { x: demoGraphX(line.to), y: 0 },
      to: { x: demoGraphX(line.to), y: mid },
      color: line.color,
    })),
    ...row.merges.map((line) => ({
      from: { x: demoGraphX(line.from), y: 0 },
      to: { x: demoGraphX(line.to), y: mid },
      color: line.color,
    })),
    ...row.lines.map((line) => ({
      from: { x: demoGraphX(line.from), y: mid },
      to: { x: demoGraphX(line.to), y: DEMO_GRAPH_ROW_HEIGHT },
      color: line.color,
    })),
  ];
}

export function demoGraphPath({ from, to }: DemoGraphSegment): string {
  if (from.x === to.x) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const mid = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${mid} ${to.x} ${mid} ${to.x} ${to.y}`;
}
