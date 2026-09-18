export interface GraphLine {
  from: number;
  to: number;
}

export interface GraphRow {
  lane: number;
  laneCount: number;
  lines: GraphLine[];
}

export function layoutCommitGraph(
  commits: { id: string; parents: string[] }[],
): GraphRow[] {
  const rows: GraphRow[] = [];
  let lanes: (string | null)[] = [];

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.id);
    if (lane === -1) {
      lane = firstEmpty(lanes);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(commit.id);
      } else {
        lanes[lane] = commit.id;
      }
    }

    const next = lanes.slice();
    for (let index = 0; index < next.length; index += 1) {
      if (next[index] === commit.id) next[index] = null;
    }

    const lines: GraphLine[] = [];

    commit.parents.forEach((parent, parentIndex) => {
      const existing = next.indexOf(parent);
      if (existing !== -1) {
        lines.push({ from: lane, to: existing });
        return;
      }
      if (parentIndex === 0) {
        next[lane] = parent;
        lines.push({ from: lane, to: lane });
        return;
      }
      let target = firstEmpty(next);
      if (target === -1) {
        target = next.length;
        next.push(parent);
      } else {
        next[target] = parent;
      }
      lines.push({ from: lane, to: target });
    });

    lanes.forEach((id, index) => {
      if (!id || id === commit.id) return;
      const dest = next.indexOf(id);
      if (dest !== -1) lines.push({ from: index, to: dest });
    });

    while (next.length > 0 && next[next.length - 1] === null) next.pop();

    rows.push({
      lane,
      laneCount: Math.max(lanes.length, next.length, 1),
      lines,
    });
    lanes = next;
  }

  return rows;
}

function firstEmpty(lanes: (string | null)[]): number {
  return lanes.findIndex((id) => id === null);
}

export function laneColor(lane: number): string {
  return `var(--graph-${(lane % 6) + 1})`;
}

export function graphWidth(laneCount: number, gap = 12): number {
  return Math.max(1, laneCount) * gap;
}
