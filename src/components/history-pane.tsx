import { useEffect, useMemo, type UIEvent } from "react";
import { AuthorAvatar } from "@/components/author-avatar";
import { formatRelativeTime } from "@/lib/format";
import { graphWidth, laneColor, layoutCommitGraph, type GraphRow } from "@/lib/commit-graph";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { CommitRef } from "@/types/git";

const ROW_HEIGHT = 32;
const LANE_GAP = 12;

export function HistoryPane() {
  const {
    commits,
    commitsHasMore,
    commitsLoading,
    historySelection,
    selectCommit,
    ensureHistory,
    loadMoreCommits,
    prefs,
  } = useGit();
  const selectedId = historySelection?.id ?? null;
  const graph = useMemo(() => layoutCommitGraph(commits), [commits]);
  const lanes = Math.max(1, ...graph.map((row) => row.laneCount));
  const gutter = graphWidth(lanes, LANE_GAP) + 8;

  useEffect(() => {
    void ensureHistory();
  }, [ensureHistory]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 240) {
      void loadMoreCommits();
    }
  }

  if (commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {commitsLoading ? "Loading history…" : "No commits yet"}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto" onScroll={onScroll}>
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
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <CommitRefs refs={commit.refs ?? []} />
            <span className="min-w-0 truncate text-sm">
              {commit.summary || "(no message)"}
            </span>
          </span>
          <span className="flex w-28 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <AuthorAvatar
              name={commit.authorName}
              email={commit.authorEmail}
              provider={prefs.avatarProvider}
            />
            <span className="truncate">{commit.authorName}</span>
          </span>
          <span className="min-w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {formatRelativeTime(commit.timestamp)}
          </span>
        </button>
      ))}
      <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
        {commitsLoading
          ? "Loading history…"
          : commitsHasMore
            ? "Scroll for earlier commits"
            : null}
      </div>
    </div>
  );
}

function CommitRefs({ refs }: { refs: CommitRef[] }) {
  if (refs.length === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-1">
      {refs.map((ref) => (
        <span
          key={`${ref.kind}:${ref.name}`}
          className={cn(
            "inline-flex h-4 items-center rounded px-1.5 font-sans text-[10px] leading-none font-medium whitespace-nowrap",
            ref.kind === "head" && "bg-yellow-400 text-zinc-950",
            ref.kind === "branch" && "bg-sky-500 text-white",
            ref.kind === "tag" && "bg-orange-500 text-white",
            ref.kind !== "head" && ref.kind !== "branch" && ref.kind !== "tag" && "bg-muted text-muted-foreground",
          )}
        >
          {ref.name}
        </span>
      ))}
    </span>
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
