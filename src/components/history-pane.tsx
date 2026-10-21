import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import {
  ArrowLeftRightIcon,
  CopyIcon,
  CopyPlusIcon,
  FileDiffIcon,
  GitBranchIcon,
  ListOrderedIcon,
  TagIcon,
  FileClockIcon,
  HashIcon,
  MailIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
  SearchIcon,
  Undo2Icon,
  UndoDotIcon,
  UserIcon,
} from "lucide-react";
import { AuthorName, ExactTime } from "@/components/revision-meta";
import { CommitLine, CreateBranchDialog, CreateTagDialog } from "@/components/create-ref-dialogs";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InteractiveRebaseDialog } from "@/components/lazy-dialogs";
import { MergeDialog, RebaseOntoDialog } from "@/components/rebase-dialog";
import { HistorySkeleton } from "@/components/skeletons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { errorMessage, expandHistoryRevs, gitApi } from "@/lib/git";
import { graphWidth, laneColor, layoutCommitGraph, type GraphRow } from "@/lib/commit-graph";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { COMMIT_PAGE, useGitPick, type ResetMode } from "@/state/git-context";
import type { CommitRef, CommitSummary } from "@/types/git";
import { toast } from "sonner";

type CommitRowAction =
  | { type: "select"; id: string }
  | { type: "branch"; commit: CommitSummary }
  | { type: "tag"; commit: CommitSummary }
  | { type: "compare"; commits: CommitSummary[] }
  | { type: "revert-many"; commits: CommitSummary[] }
  | { type: "cherry-pick-many"; commits: CommitSummary[] }
  | { type: "copy-hashes"; commits: CommitSummary[] }
  | { type: "revert"; commit: CommitSummary }
  | { type: "cherry-pick"; commit: CommitSummary }
  | { type: "reset"; commit: CommitSummary }
  | { type: "patch"; commit: CommitSummary }
  | { type: "rebase"; commit: CommitSummary }
  | { type: "merge"; commit: CommitSummary }
  | { type: "interactive"; commit: CommitSummary }
  | { type: "undo" };

const RESET_MODES: { id: ResetMode; label: string; detail: string }[] = [
  {
    id: "soft",
    label: "Soft",
    detail: "Move the branch. Staged and unstaged changes stay.",
  },
  {
    id: "mixed",
    label: "Mixed",
    detail: "Move the branch and unstage. Working tree changes stay. This is the default.",
  },
  {
    id: "hard",
    label: "Hard",
    detail: "Move the branch and discard tracked changes in the index and working tree.",
  },
  {
    id: "merge",
    label: "Merge",
    detail: "Move the branch. Stops if an unstaged edit overlaps a file that would change.",
  },
  {
    id: "keep",
    label: "Keep",
    detail: "Move the branch. Stops if a file that would change has local edits.",
  },
];

const ROW_HEIGHT = 32;
const NO_COMMITS: CommitSummary[] = [];
const LANE_GAP = 14;
const NODE_RADIUS = 4.5;
const LINE_WIDTH = 2;
const CORNER_RADIUS = 5;

export function HistoryPane() {
  const {
    commits,
    commitsHasMore,
    commitsLoading,
    historySelection,
    selectCommit,
    ensureHistory,
    loadMoreCommits,
    historyRevs,
    snapshot,
    revertCommit,
    cherryPickCommit,
    resetCommit,
    createPatch,
    openComparison,
    setOpenPanel,
    undoLastCommit,
  } = useGitPick([
    "commits",
    "commitsHasMore",
    "commitsLoading",
    "historySelection",
    "selectCommit",
    "ensureHistory",
    "loadMoreCommits",
    "historyRevs",
    "snapshot",
    "revertCommit",
    "cherryPickCommit",
    "resetCommit",
    "createPatch",
    "openComparison",
    "setOpenPanel",
    "undoLastCommit",
  ]);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  // A result records which query it answers, so a new query shows as searching
  // without resetting state first.
  const [search, setSearch] = useState<{ key: string; items: CommitSummary[]; hasMore: boolean } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [branchCommit, setBranchCommit] = useState<CommitSummary | null>(null);
  const [tagCommit, setTagCommit] = useState<CommitSummary | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "revert" | "cherry-pick"; commits: CommitSummary[] } | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectAnchor = useRef<string | null>(null);
  const [resetTarget, setResetTarget] = useState<CommitSummary | null>(null);
  const [resetMode, setResetMode] = useState<ResetMode>("mixed");
  const [rebaseTarget, setRebaseTarget] = useState<CommitSummary | null>(null);
  const [mergeTarget, setMergeTarget] = useState<CommitSummary | null>(null);
  const [interactiveTarget, setInteractiveTarget] = useState<CommitSummary | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const headPushed = Boolean(snapshot?.repo.upstream) && snapshot?.repo.ahead === 0;
  const canResetBranch = Boolean(snapshot?.repo.currentBranch) && !snapshot?.repo.isDetached;
  const canRebase = canResetBranch && !snapshot?.repo.operation;
  const currentBranch = snapshot?.repo.currentBranch;
  const selectedId = historySelection?.id ?? null;
  // Snapshot refreshes replace the branch array even when nothing changed, so
  // key the revs by content to keep the search from re-running.
  const searchRevsKey = expandHistoryRevs(historyRevs, snapshot?.branches.local).join("\0");
  const searchRevs = useMemo(() => (searchRevsKey ? searchRevsKey.split("\0") : []), [searchRevsKey]);
  const searchGeneration = useRef(0);
  const repoPath = snapshot?.repo.path;
  const searchKey = `${repoPath ?? ""}\0${applied}\0${searchRevsKey}`;
  const answered = applied && search?.key === searchKey ? search : null;
  const results = answered?.items ?? null;
  const searchHasMore = answered?.hasMore ?? false;
  const searching = Boolean(applied) && (!answered || loadingMore);
  const searchingMode = Boolean(applied);
  const visible = searchingMode ? (results ?? NO_COMMITS) : commits;
  const graph = useMemo(
    () => (searchingMode ? [] : layoutCommitGraph(visible)),
    [searchingMode, visible],
  );
  const loading = searchingMode ? searching : commitsLoading;
  const hasMore = searchingMode ? searchHasMore : commitsHasMore;
  const effectiveSelection = useMemo(
    () => (selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : []),
    [selectedId, selectedIds],
  );
  const selectionRef = useRef({ visible, effectiveSelection, selectedId });
  useLayoutEffect(() => {
    selectionRef.current = { visible, effectiveSelection, selectedId };
  });
  const rows = useWindowedRows(visible.length, ROW_HEIGHT);
  const onRowAction = useCallback(
    (action: CommitRowAction) => {
      switch (action.type) {
        case "select":
          void selectCommit(action.id);
          break;
        case "branch":
          setBranchCommit(action.commit);
          break;
        case "tag":
          setTagCommit(action.commit);
          break;
        case "compare": {
          const [older, newer] = [...action.commits].sort((left, right) => left.timestamp - right.timestamp);
          if (!older || !newer) break;
          openComparison(
            { rev: older.id, label: older.shortId },
            { rev: newer.id, label: newer.shortId },
          );
          break;
        }
        case "revert":
          setConfirm({ kind: "revert", commits: [action.commit] });
          break;
        case "revert-many":
          setConfirm({
            kind: "revert",
            commits: [...action.commits].sort((left, right) => right.timestamp - left.timestamp),
          });
          break;
        case "cherry-pick":
          setConfirm({ kind: "cherry-pick", commits: [action.commit] });
          break;
        case "cherry-pick-many":
          setConfirm({
            kind: "cherry-pick",
            commits: [...action.commits].sort((left, right) => left.timestamp - right.timestamp),
          });
          break;
        case "copy-hashes":
          void navigator.clipboard.writeText(action.commits.map((commit) => commit.id).join("\n")).then(
            () => toast.success(action.commits.length === 1 ? "Copied commit hash" : "Copied commit hashes"),
            () => toast.error("Could not copy"),
          );
          break;
        case "reset":
          setResetMode("mixed");
          setResetTarget(action.commit);
          break;
        case "patch":
          void createPatch(action.commit);
          break;
        case "rebase":
          setRebaseTarget(action.commit);
          break;
        case "merge":
          setMergeTarget(action.commit);
          break;
        case "interactive":
          setInteractiveTarget(action.commit);
          break;
        case "undo":
          if (headPushed) setConfirmUndo(true);
          else void undoLastCommit();
          break;
      }
    },
    [createPatch, headPushed, openComparison, selectCommit, undoLastCommit],
  );

  const selectRows = useCallback(
    (id: string, mode: "single" | "toggle" | "range") => {
      const { visible, effectiveSelection: base, selectedId } = selectionRef.current;
      const ids = visible.map((commit) => commit.id);
      if (mode === "toggle") {
        const next = base.includes(id) ? base.filter((item) => item !== id) : [...base, id];
        setSelectedIds(next);
        if (next.length === 1) {
          const only = next[0];
          if (only) void selectCommit(only);
        }
        selectAnchor.current = id;
        return;
      }
      const anchor = selectAnchor.current ?? selectedId;
      if (mode === "range" && anchor) {
        const start = ids.indexOf(anchor);
        const end = ids.indexOf(id);
        if (start >= 0 && end >= 0) {
          const [from, to] = start < end ? [start, end] : [end, start];
          setSelectedIds(ids.slice(from, to + 1));
          return;
        }
      }
      setSelectedIds([id]);
      selectAnchor.current = id;
      void selectCommit(id);
    },
    [selectCommit],
  );

  const selectedCommits = useCallback(() => {
    const { visible, effectiveSelection } = selectionRef.current;
    const chosen = new Set(effectiveSelection);
    return visible.filter((commit) => chosen.has(commit.id));
  }, []);

  useEffect(() => {
    void ensureHistory();
  }, [ensureHistory]);

  useEffect(() => {
    if (!applied || !repoPath) return;
    const key = searchKey;
    const generation = ++searchGeneration.current;
    void gitApi
      .getCommits(repoPath, COMMIT_PAGE, 0, applied, searchRevs)
      .then((items) => {
        if (searchGeneration.current !== generation) return;
        setSearch({ key, items, hasMore: items.length === COMMIT_PAGE });
      })
      .catch((error) => {
        if (searchGeneration.current !== generation) return;
        toast.error(errorMessage(error));
        setSearch({ key, items: [], hasMore: false });
      });
    return () => {
      searchGeneration.current += 1;
    };
  }, [applied, repoPath, searchKey, searchRevs]);

  async function loadMoreSearch() {
    if (!repoPath || !applied || searching || !searchHasMore || !results) return;
    const key = searchKey;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    try {
      const more = await gitApi.getCommits(
        repoPath,
        COMMIT_PAGE,
        results.length,
        applied,
        searchRevs,
      );
      if (searchGeneration.current !== generation) return;
      setSearch((current) =>
        current?.key === key
          ? { key, items: [...current.items, ...more], hasMore: more.length === COMMIT_PAGE }
          : current,
      );
    } catch (error) {
      if (searchGeneration.current === generation) toast.error(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (node.scrollHeight - node.scrollTop - node.clientHeight >= 240) return;
    if (searchingMode) void loadMoreSearch();
    else void loadMoreCommits();
  }

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <HoverTip
            label={
              "Words match the subject, author, hash, or a branch or tag. Narrow with filters:\n" +
              "author:name  path:src/file.cs  content:\"text added or removed\"\n" +
              "regex:pattern  since:2.weeks  until:2026-01-01"
            }
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setApplied(query.trim());
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setQuery("");
                  setApplied("");
                }
              }}
              placeholder="Search commits · author: path: content: since:"
              className="h-7 pl-7"
            />
          </HoverTip>
        </div>
        <HoverTip label="Reflog">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reflog"
            onClick={() => setOpenPanel("reflog")}
          >
            <FileClockIcon />
          </Button>
        </HoverTip>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={rows.viewportRef} onScroll={onScroll}>
        {visible.length === 0 ? (
          loading ? (
            <HistorySkeleton fill label={searchingMode ? "Searching" : "Loading history"} />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              {searchingMode ? "No matching commits" : "No commits yet"}
            </div>
          )
        ) : (
          <CommitList
            commits={visible}
            graph={graph}
            showGraph={!searchingMode}
            selectedIds={effectiveSelection}
            start={rows.start}
            end={rows.end}
            before={rows.before}
            after={rows.after}
            loading={loading}
            searchingMode={searchingMode}
            hasMore={hasMore}
            canResetBranch={canResetBranch}
            canRebase={canRebase}
            onSelect={selectRows}
            onAction={onRowAction}
            getSelectedCommits={selectedCommits}
          />
        )}
      </ScrollArea>
      <CreateTagDialog
        commit={tagCommit}
        open={Boolean(tagCommit)}
        onOpenChange={(open) => {
          if (!open) setTagCommit(null);
        }}
      />
      <CreateBranchDialog
        commit={branchCommit}
        open={Boolean(branchCommit)}
        onOpenChange={(open) => {
          if (!open) setBranchCommit(null);
        }}
      />
      <Dialog open={confirmUndo} onOpenChange={setConfirmUndo}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo a pushed commit?</DialogTitle>
            <DialogDescription>
              {snapshot?.headCommit?.summary ? `“${snapshot.headCommit.summary}” ` : "The last commit "}
              is already on {snapshot?.repo.upstream}. Undoing it here leaves the remote unchanged, so
              publishing again needs a force push.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUndo(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmUndo(false);
                void undoLastCommit();
              }}
            >
              Undo commit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader className="min-w-0">
            <DialogTitle>
              {confirm?.kind === "revert"
                ? confirm.commits.length > 1
                  ? `Revert ${confirm.commits.length} commits?`
                  : "Revert this commit?"
                : confirm && confirm.commits.length > 1
                  ? `Cherry-pick ${confirm.commits.length} commits?`
                  : "Cherry-pick this commit?"}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "revert"
                ? confirm.commits.length > 1
                  ? "Creates new commits that undo these changes, newest first."
                  : "Creates a new commit that undoes this change on the current branch."
                : confirm && confirm.commits.length > 1
                  ? "Applies these commits onto the current branch, oldest first."
                  : "Applies this commit onto the current branch."}
            </DialogDescription>
          </DialogHeader>
          {confirm && confirm.commits.length > 1 ? (
            <div className="mt-2 space-y-1">
              {confirm.commits.map((commit) => (
                <CommitLine key={commit.id} commit={commit} />
              ))}
            </div>
          ) : (
            <CommitLine commit={confirm?.commits[0]} />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirm?.kind === "revert" ? "destructive" : "default"}
              onClick={() => {
                const next = confirm;
                if (!next) return;
                setConfirm(null);
                void (async () => {
                  for (const commit of next.commits) {
                    const ok =
                      next.kind === "revert"
                        ? await revertCommit(commit.id)
                        : await cherryPickCommit(commit.id);
                    if (!ok) break;
                  }
                })();
              }}
            >
              {confirm?.kind === "revert" ? "Revert" : "Cherry-pick"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(resetTarget)}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
      >
        <DialogContent className="overflow-hidden sm:max-w-md">
          <form
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              const commit = resetTarget;
              if (!commit) return;
              setResetTarget(null);
              void resetCommit(commit.id, resetMode);
            }}
          >
            <DialogHeader className="min-w-0 pr-6">
              <DialogTitle className="truncate">Reset {currentBranch ?? "branch"}?</DialogTitle>
              <DialogDescription>Moves this branch to the selected commit.</DialogDescription>
            </DialogHeader>
            <CommitLine commit={resetTarget} />
            <div className="mt-3 flex flex-col gap-1">
              {RESET_MODES.map((mode) => {
                const selected = resetMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "rounded-md border px-2.5 py-2 text-left",
                      selected
                        ? "border-foreground/30 bg-muted"
                        : "border-transparent hover:bg-muted/60",
                    )}
                    onClick={() => setResetMode(mode.id)}
                  >
                    <span className="text-sm font-medium">{mode.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{mode.detail}</span>
                  </button>
                );
              })}
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setResetTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" variant={resetMode === "hard" ? "destructive" : "default"}>
                {resetMode === "hard" ? "Hard reset" : "Reset"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <MergeDialog
        target={mergeTarget ? { onto: mergeTarget.id, label: mergeTarget.shortId } : null}
        onOpenChange={(open) => {
          if (!open) setMergeTarget(null);
        }}
      />
      <RebaseOntoDialog
        target={
          rebaseTarget
            ? { onto: rebaseTarget.id, label: rebaseTarget.shortId }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setRebaseTarget(null);
        }}
      />
      <InteractiveRebaseDialog
        onto={
          interactiveTarget
            ? { id: interactiveTarget.id, label: interactiveTarget.shortId }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setInteractiveTarget(null);
        }}
      />
    </div>
  );
}

const CommitList = memo(function CommitList({
  commits,
  graph,
  showGraph,
  selectedIds,
  start,
  end,
  before,
  after,
  loading,
  searchingMode,
  hasMore,
  canResetBranch,
  canRebase,
  onSelect,
  onAction,
  getSelectedCommits,
}: {
  commits: CommitSummary[];
  graph: GraphRow[];
  showGraph: boolean;
  selectedIds: string[];
  start: number;
  end: number;
  before: number;
  after: number;
  loading: boolean;
  searchingMode: boolean;
  hasMore: boolean;
  canResetBranch: boolean;
  canRebase: boolean;
  onSelect: (id: string, mode: "single" | "toggle" | "range") => void;
  onAction: (action: CommitRowAction) => void;
  getSelectedCommits: () => CommitSummary[];
}) {
  const graphCells = useMemo(
    () =>
      commits.map((_, index) =>
        showGraph && graph[index]
          ? {
              width: rowGraphWidth(graph[index], graph[index - 1]),
              row: graph[index],
              previous: graph[index - 1],
            }
          : null,
      ),
    [commits, graph, showGraph],
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const multi = selectedIds.length > 1;

  return (
    <>
      <div style={{ height: before }} />
      {commits.slice(start, end).map((commit, offset) => (
        <CommitRow
          key={commit.id}
          commit={commit}
          selected={selected.has(commit.id)}
          multi={multi && selected.has(commit.id)}
          graph={graphCells[start + offset]}
          canResetBranch={canResetBranch}
          canRebase={canRebase}
          onSelect={onSelect}
          onAction={onAction}
          getSelectedCommits={getSelectedCommits}
        />
      ))}
      <div style={{ height: after }} />
      {loading ? (
        <HistorySkeleton
          rows={3}
          label={searchingMode ? "Searching" : "Loading history"}
        />
      ) : hasMore ? (
        <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
          Scroll for earlier commits
        </div>
      ) : null}
    </>
  );
});

const CommitRow = memo(function CommitRow({
  commit,
  selected,
  multi,
  graph,
  canResetBranch,
  canRebase,
  onSelect,
  onAction,
  getSelectedCommits,
}: {
  commit: CommitSummary;
  selected: boolean;
  multi: boolean;
  graph: { width: number; row: GraphRow; previous?: GraphRow } | null;
  canResetBranch: boolean;
  canRebase: boolean;
  onSelect: (id: string, mode: "single" | "toggle" | "range") => void;
  onAction: (action: CommitRowAction) => void;
  getSelectedCommits: () => CommitSummary[];
}) {
  const message = [commit.summary, commit.body].filter(Boolean).join("\n\n");
  const isHead = (commit.refs ?? []).some((ref) => ref.kind === "head");

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
          onClick={(event) =>
            onSelect(commit.id, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single")
          }
          onContextMenu={() => {
            if (!selected) onSelect(commit.id, "single");
          }}
        >
          {graph ? (
            <GraphCell
              width={graph.width}
              row={graph.row}
              previous={graph.previous}
              selected={selected}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <CommitRefs refs={commit.refs ?? []} />
            <span
              className={cn(
                "min-w-0 truncate text-sm",
                commit.onCurrentBranch === false && "text-muted-foreground/50",
              )}
            >
              {commit.summary || "(no message)"}
            </span>
          </span>
          <AuthorName name={commit.authorName} email={commit.authorEmail} />
          <ExactTime time={commit.timestamp} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {multi ? (
          <MultiCommitMenu getCommits={getSelectedCommits} onAction={onAction} />
        ) : (
        <>
        {isHead ? (
          <ContextMenuItem onClick={() => onAction({ type: "undo" })}>
            <UndoDotIcon />
            Undo
          </ContextMenuItem>
        ) : null}
        {canResetBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "reset", commit })}>
            <RotateCcwIcon />
            Reset
          </ContextMenuItem>
        ) : null}
        {commit.onCurrentBranch ? null : (
          <ContextMenuItem onClick={() => onAction({ type: "cherry-pick", commit })}>
            <CopyPlusIcon />
            Cherry-pick
          </ContextMenuItem>
        )}
        {canRebase && !commit.onCurrentBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "merge", commit })}>
            <GitBranchIcon />
            Merge
          </ContextMenuItem>
        ) : null}
        {commit.onCurrentBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "revert", commit })}>
            <Undo2Icon />
            Revert
          </ContextMenuItem>
        ) : null}
        {canRebase && !commit.onCurrentBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "rebase", commit })}>
            <GitBranchIcon />
            Rebase onto
          </ContextMenuItem>
        ) : null}
        {canRebase && commit.onCurrentBranch && !commit.refs.some((ref) => ref.kind === "head") ? (
          <ContextMenuItem onClick={() => onAction({ type: "interactive", commit })}>
            <ListOrderedIcon />
            Interactive rebase
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => onAction({ type: "branch", commit })}>
          <GitBranchIcon />
          Create branch
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction({ type: "tag", commit })}>
          <TagIcon />
          Create tag
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction({ type: "patch", commit })}>
          <FileDiffIcon />
          Create patch
        </ContextMenuItem>
        <ContextMenuSeparator />
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
            {commit.authorEmail ? (
              <ContextMenuItem onClick={() => void copyText(commit.authorEmail, "Copied email")}>
                <MailIcon />
                Email
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => void copyText(commit.id, "Copied commit hash")}>
              <HashIcon />
              Hash
            </ContextMenuItem>
            {message ? (
              <ContextMenuItem onClick={() => void copyText(message, "Copied message")}>
                <MessageSquareTextIcon />
                Message
              </ContextMenuItem>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>
        </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function MultiCommitMenu({
  getCommits,
  onAction,
}: {
  getCommits: () => CommitSummary[];
  onAction: (action: CommitRowAction) => void;
}) {
  const commits = getCommits();
  const canCherryPick = commits.every((commit) => !commit.onCurrentBranch);
  const canRevert = commits.every((commit) => commit.onCurrentBranch);
  return (
    <>
      {commits.length === 2 ? (
        <ContextMenuItem onClick={() => onAction({ type: "compare", commits })}>
          <ArrowLeftRightIcon />
          Compare
        </ContextMenuItem>
      ) : null}
      {canCherryPick ? (
        <ContextMenuItem onClick={() => onAction({ type: "cherry-pick-many", commits })}>
          <CopyPlusIcon />
          Cherry-pick
        </ContextMenuItem>
      ) : null}
      {canRevert ? (
        <ContextMenuItem onClick={() => onAction({ type: "revert-many", commits })}>
          <Undo2Icon />
          Revert
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onAction({ type: "copy-hashes", commits })}>
        <HashIcon />
        Copy hashes
      </ContextMenuItem>
    </>
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
            ref.kind === "head" && "bg-[var(--ref-head)] text-[var(--ref-head-fg)]",
            ref.kind === "branch" && "bg-[var(--ref-branch)] text-[var(--ref-branch-fg)]",
            ref.kind === "tag" && "bg-[var(--ref-tag)] text-[var(--ref-tag-fg)]",
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
  for (const line of row.merges) {
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
  selected,
}: {
  width: number;
  row: GraphRow;
  previous?: GraphRow;
  selected: boolean;
}) {
  const mid = ROW_HEIGHT / 2;
  const color = laneColor(row.lane);
  const mergeFrom = new Set(row.merges.map((line) => line.from));
  const incoming = previous
    ? [...new Map(previous.lines.map((line) => [line.to, line])).values()]
    : [];

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      className="shrink-0 overflow-visible"
      aria-hidden
    >
      {incoming.map((line) =>
        mergeFrom.has(line.to) ? null : (
          <line
            key={`in-${line.to}`}
            x1={line.to * LANE_GAP + LANE_GAP / 2}
            y1="0"
            x2={line.to * LANE_GAP + LANE_GAP / 2}
            y2={mid}
            stroke={laneColor(line.color)}
            strokeWidth={LINE_WIDTH}
            strokeLinecap="round"
          />
        ),
      )}
      {row.merges.map((line, index) => (
        <path
          key={`merge-${index}`}
          d={mergeIn(line.from, line.to, mid)}
          fill="none"
          stroke={laneColor(line.color)}
          strokeWidth={LINE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {row.lines.map((line, index) => (
        <path
          key={`out-${index}`}
          d={branchOut(line.from, line.to, mid, ROW_HEIGHT)}
          fill="none"
          stroke={laneColor(line.color)}
          strokeWidth={LINE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <circle
        cx={row.lane * LANE_GAP + LANE_GAP / 2}
        cy={mid}
        r={NODE_RADIUS}
        fill={selected ? color : "var(--background)"}
        stroke={color}
        strokeWidth={LINE_WIDTH}
      />
    </svg>
  );
}

function laneX(lane: number): number {
  return lane * LANE_GAP + LANE_GAP / 2;
}

function mergeIn(from: number, to: number, mid: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  if (x1 === x2) return `M ${x1} 0 L ${x2} ${mid}`;
  const dx = x2 - x1;
  const radius = Math.min(CORNER_RADIUS, Math.abs(dx) / 2, mid / 2);
  const sign = dx > 0 ? 1 : -1;
  return `M ${x1} 0 L ${x1} ${mid - radius} Q ${x1} ${mid} ${x1 + sign * radius} ${mid} L ${x2} ${mid}`;
}

function branchOut(from: number, to: number, y1: number, y2: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dx = x2 - x1;
  const radius = Math.min(CORNER_RADIUS, Math.abs(dx) / 2, (y2 - y1) / 2);
  const sign = dx > 0 ? 1 : -1;
  return `M ${x1} ${y1} L ${x2 - sign * radius} ${y1} Q ${x2} ${y1} ${x2} ${y1 + radius} L ${x2} ${y2}`;
}
