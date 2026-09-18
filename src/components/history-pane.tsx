import { useMemo } from "react";
import { formatRelativeTime } from "@/lib/format";
import { graphWidth, laneColor, layoutCommitGraph, type GraphRow } from "@/lib/commit-graph";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

const ROW_HEIGHT = 32;
const LANE_GAP = 12;

export function HistoryPane() {
  const { commits, historySelection, selectCommit } = useGit();
  const selectedId = historySelection?.id ?? null;
  const graph = useMemo(() => layoutCommitGraph(commits), [commits]);
  const lanes = Math.max(1, ...graph.map((row) => row.laneCount));
  const gutter = graphWidth(lanes, LANE_GAP) + 8;

  if (commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No commits yet
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {commits.map((commit, index) => (
        <button
          key={commit.id}
          type="button"
          className={cn(
            "flex h-8 w-full items-center gap-3 px-2 text-left hover:bg-muted/70",
            selectedId === commit.id && "bg-muted",
          )}
          onClick={() => void selectCommit(commit.id)}
        >
          <GraphCell
            width={gutter}
            row={graph[index]}
            previous={graph[index - 1]}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {commit.summary || "(no message)"}
          </span>
          <span className="w-24 shrink-0 truncate text-[11px] text-muted-foreground">
            {commit.authorName}
          </span>
          <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">
            {commit.shortId}
          </span>
          <span className="min-w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {formatRelativeTime(commit.timestamp)}
          </span>
        </button>
      ))}
    </div>
  );
}

function GraphCell({
  width,
  row,
  previous,
}: {
  width: number;
  row: GraphRow;
  previous?: GraphRow;
}) {
  const mid = ROW_HEIGHT / 2;

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      className="shrink-0 overflow-visible"
      aria-hidden
    >
      {previous
        ? [...new Set(previous.lines.map((line) => line.to))].map((lane) => (
            <line
              key={`in-${lane}`}
              x1={lane * LANE_GAP + LANE_GAP / 2}
              y1="0"
              x2={lane * LANE_GAP + LANE_GAP / 2}
              y2={mid}
              stroke={laneColor(lane)}
              strokeWidth="1.25"
            />
          ))
        : null}
      {row.lines.map((line, index) => (
        <path
          key={`out-${index}`}
          d={connector(line.from, line.to, mid, ROW_HEIGHT)}
          fill="none"
          stroke={laneColor(line.to)}
          strokeWidth="1.25"
        />
      ))}
      <circle
        cx={row.lane * LANE_GAP + LANE_GAP / 2}
        cy={mid}
        r="3"
        fill={laneColor(row.lane)}
      />
    </svg>
  );
}

function connector(from: number, to: number, y1: number, y2: number): string {
  const x1 = from * LANE_GAP + LANE_GAP / 2;
  const x2 = to * LANE_GAP + LANE_GAP / 2;
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}
