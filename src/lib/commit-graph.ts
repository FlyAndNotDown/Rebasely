export interface GraphLine {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  laneCount: number;
  lines: GraphLine[];
  merges: GraphLine[];
}

export function layoutCommitGraph(
  commits: { id: string; parents: string[] }[],
): GraphRow[] {
  const rows: GraphRow[] = [];
  let lanes: (string | null)[] = [];
  const seen = new Set<string>();

  for (const commit of commits) {
    const reserved: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] === commit.id) reserved.push(index);
    }

    let lane: number;
    if (reserved.length === 0) {
      lane = firstEmpty(lanes);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(commit.id);
      } else {
        lanes[lane] = commit.id;
      }
      reserved.push(lane);
    } else {
      lane = reserved[0];
    }

    const next = lanes.slice();
    for (const index of reserved) next[index] = null;

    const lines: GraphLine[] = [];
    const merges: GraphLine[] = [];
    for (const index of reserved) {
      if (index !== lane) {
        merges.push({ from: index, to: lane, color: index });
      }
    }

    const reuse = reserved.filter((index) => index !== lane);

    commit.parents.forEach((parent, parentIndex) => {
      if (seen.has(parent)) return;
      if (parentIndex === 0) {
        next[lane] = parent;
        lines.push({ from: lane, to: lane, color: lane });
        return;
      }

      const existing = next.indexOf(parent);
      if (existing !== -1) {
        lines.push({ from: lane, to: existing, color: existing });
        return;
      }

      const reused = reuse.shift();
      if (reused !== undefined) {
        next[reused] = parent;
        lines.push({ from: lane, to: reused, color: reused });
        return;
      }

      let target = firstEmpty(next);
      if (target === -1) {
        target = next.length;
        next.push(parent);
      } else {
        next[target] = parent;
      }
      lines.push({ from: lane, to: target, color: target });
    });

    lanes.forEach((id, index) => {
      if (!id || id === commit.id) return;
      if (next[index] === id) {
        lines.push({ from: index, to: index, color: index });
      }
    });

    while (next.length > 0 && next[next.length - 1] === null) next.pop();

    rows.push({
      lane,
      laneCount: Math.max(lanes.length, next.length, 1),
      lines,
      merges,
    });
    lanes = next;
    seen.add(commit.id);
  }

  return rows;
}

function firstEmpty(lanes: (string | null)[]): number {
  return lanes.findIndex((id) => id === null);
}

const GRAPH_LANE_COLORS = 12;

export function laneColor(lane: number): string {
  return `var(--graph-${(lane % GRAPH_LANE_COLORS) + 1})`;
}

export function graphWidth(laneCount: number, gap = 12): number {
  return Math.max(1, laneCount) * gap;
}
