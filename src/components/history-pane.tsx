import { useEffect, useMemo, useState, type UIEvent } from "react";
import { CopyIcon, HashIcon, MailIcon, MessageSquareTextIcon, SearchIcon, UserIcon } from "lucide-react";
import { AuthorAvatar } from "@/components/author-avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { formatAbsoluteTime } from "@/lib/format";
import { errorMessage, gitApi } from "@/lib/git";
import { graphWidth, laneColor, layoutCommitGraph, type GraphRow } from "@/lib/commit-graph";
import { cn } from "@/lib/utils";
import { COMMIT_PAGE, useGit } from "@/state/git-context";
import type { AvatarProvider, CommitRef, CommitSummary } from "@/types/git";
import { toast } from "sonner";

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
    snapshot,
  } = useGit();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<CommitSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const selectedId = historySelection?.id ?? null;
  const searchingMode = Boolean(debounced);
  const visible = searchingMode ? (results ?? []) : commits;
  const graph = useMemo(
    () => (searchingMode ? [] : layoutCommitGraph(visible)),
    [searchingMode, visible],
  );
  const loading = searchingMode ? searching : commitsLoading;
  const hasMore = searchingMode ? searchHasMore : commitsHasMore;

  useEffect(() => {
    void ensureHistory();
  }, [ensureHistory]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setResults(null);
      setSearchHasMore(false);
      setSearching(false);
      return;
    }
    const repoPath = snapshot?.repo.path;
    if (!repoPath) return;
    let cancelled = false;
    setSearching(true);
    void gitApi
      .getCommits(repoPath, COMMIT_PAGE, 0, debounced)
      .then((items) => {
        if (cancelled) return;
        setResults(items);
        setSearchHasMore(items.length === COMMIT_PAGE);
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, snapshot?.repo.path]);

  async function loadMoreSearch() {
    const repoPath = snapshot?.repo.path;
    if (!repoPath || !debounced || searching || !searchHasMore || !results) return;
    setSearching(true);
    try {
      const more = await gitApi.getCommits(repoPath, COMMIT_PAGE, results.length, debounced);
      setResults((current) => [...(current ?? []), ...more]);
      setSearchHasMore(more.length === COMMIT_PAGE);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (node.scrollHeight - node.scrollTop - node.clientHeight >= 240) return;
    if (searchingMode) void loadMoreSearch();
    else void loadMoreCommits();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-2 py-1.5">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commits"
            className="h-7 pl-7"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {loading
              ? searchingMode
                ? "Searching…"
                : "Loading history…"
              : searchingMode
                ? "No matching commits"
                : "No commits yet"}
          </div>
        ) : (
          <>
            {visible.map((commit, index) => (
              <CommitRow
                key={commit.id}
                commit={commit}
                selected={selectedId === commit.id}
                avatarProvider={prefs.avatarProvider}
                graph={
                  !searchingMode && graph[index]
                    ? {
                        width: rowGraphWidth(graph[index], graph[index - 1]),
                        row: graph[index],
                        previous: graph[index - 1],
                      }
                    : null
                }
                onSelect={() => void selectCommit(commit.id)}
              />
            ))}
            <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
              {loading
                ? searchingMode
                  ? "Searching…"
                  : "Loading history…"
                : hasMore
                  ? "Scroll for earlier commits"
                  : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CommitRow({
  commit,
  selected,
  avatarProvider,
  graph,
  onSelect,
}: {
  commit: CommitSummary;
  selected: boolean;
  avatarProvider: AvatarProvider;
  graph: { width: number; row: GraphRow; previous?: GraphRow } | null;
  onSelect: () => void;
}) {
  const message = [commit.summary, commit.body].filter(Boolean).join("\n\n");

  async function copyText(value: string, success: string) {
    if (!value) {
      toast.error("Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success(success);
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 w-full items-center gap-2 px-2 text-left hover:bg-muted/70",
            selected && "bg-muted",
          )}
          onClick={onSelect}
        >
          {graph ? (
            <GraphCell width={graph.width} row={graph.row} previous={graph.previous} />
          ) : null}
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
              provider={avatarProvider}
            />
            <span className="truncate">{commit.authorName}</span>
          </span>
          <span
            className="w-[7.25rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
            title={formatAbsoluteTime(commit.timestamp)}
          >
            {formatAbsoluteTime(commit.timestamp)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CopyIcon />
            Copy
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem onClick={() => void copyText(commit.authorName, "Copied author")}>
              <UserIcon />
              Author
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!commit.authorEmail}
              onClick={() => void copyText(commit.authorEmail, "Copied email")}
            >
              <MailIcon />
              Email
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void copyText(commit.id, "Copied commit hash")}>
              <HashIcon />
              Hash
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!message}
              onClick={() => void copyText(message, "Copied message")}
            >
              <MessageSquareTextIcon />
              Message
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
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

function rowGraphWidth(row: GraphRow, previous?: GraphRow): number {
  let maxLane = row.lane;
  for (const line of row.lines) {
    maxLane = Math.max(maxLane, line.from, line.to);
  }
  if (previous) {
    for (const line of previous.lines) {
      maxLane = Math.max(maxLane, line.to);
    }
  }
  return graphWidth(maxLane + 1, LANE_GAP) + 8;
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
