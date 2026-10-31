import { t, useTranslation } from "@/i18n";
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
import { orderReplayCommits, replayCommitBatch } from "@/state/repository-actions";
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

const RESET_MODES: { id: ResetMode; labelKey: string; detailKey: string }[] = [
  {
    id: "soft",
    labelKey: "git.ui.soft",
    detailKey: "git.ui.move_the_branch_staged_and_unstaged_changes_stay",
  },
  {
    id: "mixed",
    labelKey: "git.ui.mixed",
    detailKey: "git.ui.move_the_branch_and_unstage_working_tree_changes_stay_this_is_the_default",
  },
  {
    id: "hard",
    labelKey: "git.ui.hard",
    detailKey: "git.ui.move_the_branch_and_discard_tracked_changes_in_the_index_and_working_tree",
  },
  {
    id: "merge",
    labelKey: "git.ui.merge",
    detailKey: "git.ui.move_the_branch_stops_if_an_unstaged_edit_overlaps_a_file_that_would_change",
  },
  {
    id: "keep",
    labelKey: "git.ui.keep",
    detailKey: "git.ui.move_the_branch_stops_if_a_file_that_would_change_has_local_edits",
  },
];

const ROW_HEIGHT = 32;
const NO_COMMITS: CommitSummary[] = [];
const LANE_GAP = 14;
const NODE_RADIUS = 4.5;
const LINE_WIDTH = 2;
const CORNER_RADIUS = 5;

export function HistoryPane() {
  useTranslation();
  const {
    activeTabId,
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
    setView,
    undoLastCommit,
  } = useGitPick([
    "activeTabId",
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
    "setView",
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
            commits: orderReplayCommits(action.commits, "revert"),
          });
          break;
        case "cherry-pick":
          setConfirm({ kind: "cherry-pick", commits: [action.commit] });
          break;
        case "cherry-pick-many":
          setConfirm({
            kind: "cherry-pick",
            commits: orderReplayCommits(action.commits, "cherry-pick"),
          });
          break;
        case "copy-hashes":
          void navigator.clipboard.writeText(action.commits.map((commit) => commit.id).join("\n")).then(
            () => toast.success(action.commits.length === 1 ? t("git.ui.copied_commit_hash") : t("git.ui.copied_commit_hashes")),
            () => toast.error(t("git.ui.could_not_copy")),
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
              t("git.dynamic.searchHelp") + "\n" +
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
              placeholder={t("git.ui.search_commits_author_path_content_since")}
              className="h-7 pl-7"
            />
          </HoverTip>
        </div>
        <HoverTip label={t("git.ui.reflog")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("git.ui.reflog")}
            onClick={() => setOpenPanel("reflog")}
          >
            <FileClockIcon />
          </Button>
        </HoverTip>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={rows.viewportRef} onScroll={onScroll}>
        {visible.length === 0 ? (
          loading ? (
            <HistorySkeleton fill label={searchingMode ? t("git.ui.searching") : t("git.ui.loading_history")} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
              <p role="status">{searchingMode ? t("git.ui.no_matching_commits") : t("git.ui.no_commits_yet")}</p>
              {searchingMode ? (
                <Button variant="outline" size="sm" onClick={() => { setQuery(""); setApplied(""); }}>{t("git.ui.clear_filter")}</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setView("changes")}>{t("git.ui.review_changes")}</Button>
              )}
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
            <DialogTitle>{t("git.ui.undo_a_pushed_commit")}</DialogTitle>
            <DialogDescription>
              {t("git.dynamic.undoPushedDescription", { commit: snapshot?.headCommit?.summary ?? t("git.dynamic.lastCommit"), upstream: snapshot?.repo.upstream })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUndo(false)}>{t("git.ui.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmUndo(false);
                void undoLastCommit();
              }}
            >{t("git.ui.undo_commit")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader className="min-w-0">
            <DialogTitle>
              {confirm?.kind === "revert"
                ? confirm.commits.length > 1
                  ? t("git.dynamic.revertCommits", { count: confirm.commits.length })
                  : t("git.ui.revert_this_commit")
                : confirm && confirm.commits.length > 1
                  ? t("git.dynamic.cherryPickCommits", { count: confirm.commits.length })
                  : t("git.ui.cherry_pick_this_commit")}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "revert"
                ? confirm.commits.length > 1
                  ? t("git.ui.creates_new_commits_that_undo_these_changes_newest_first")
                  : t("git.ui.creates_a_new_commit_that_undoes_this_change_on_the_current_branch")
                : confirm && confirm.commits.length > 1
                  ? t("git.ui.applies_these_commits_onto_the_current_branch_oldest_first")
                  : t("git.ui.applies_this_commit_onto_the_current_branch")}
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
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>{t("git.ui.cancel")}</Button>
            <Button
              type="button"
              variant={confirm?.kind === "revert" ? "destructive" : "default"}
              onClick={() => {
                const next = confirm;
                if (!next) return;
                setConfirm(null);
                void replayCommitBatch(
                  activeTabId,
                  next.commits,
                  next.kind === "revert" ? revertCommit : cherryPickCommit,
                );
              }}
            >
              {confirm?.kind === "revert" ? t("git.ui.revert") : t("git.ui.cherry_pick")}
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
              <DialogTitle className="truncate">{t("git.dynamic.resetBranch", { name: currentBranch ?? t("git.ui.branch") })}</DialogTitle>
              <DialogDescription>{t("git.ui.moves_this_branch_to_the_selected_commit")}</DialogDescription>
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
                    <span className="text-sm font-medium">{t(mode.labelKey)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t(mode.detailKey)}</span>
                  </button>
                );
              })}
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setResetTarget(null)}>{t("git.ui.cancel")}</Button>
              <Button type="submit" variant={resetMode === "hard" ? "destructive" : "default"}>
                {resetMode === "hard" ? t("git.ui.hard_reset") : t("git.ui.reset")}
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
  useTranslation();
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
          label={searchingMode ? t("git.ui.searching") : t("git.ui.loading_history")}
        />
      ) : hasMore ? (
        <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">{t("git.ui.scroll_for_earlier_commits")}</div>
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
  useTranslation();
  const message = [commit.summary, commit.body].filter(Boolean).join("\n\n");
  const isHead = (commit.refs ?? []).some((ref) => ref.kind === "head");

  async function copyText(value: string, success: string) {
    if (!value) {
      toast.error(t("git.ui.nothing_to_copy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success(success);
    } catch {
      toast.error(t("git.ui.could_not_copy"));
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
              {commit.summary || t("git.ui.no_message")}
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
            <UndoDotIcon />{t("git.ui.undo")}</ContextMenuItem>
        ) : null}
        {canResetBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "reset", commit })}>
            <RotateCcwIcon />{t("git.ui.reset")}</ContextMenuItem>
        ) : null}
        {commit.onCurrentBranch ? null : (
          <ContextMenuItem onClick={() => onAction({ type: "cherry-pick", commit })}>
            <CopyPlusIcon />{t("git.ui.cherry_pick")}</ContextMenuItem>
        )}
        {canRebase && !commit.onCurrentBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "merge", commit })}>
            <GitBranchIcon />{t("git.ui.merge")}</ContextMenuItem>
        ) : null}
        {commit.onCurrentBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "revert", commit })}>
            <Undo2Icon />{t("git.ui.revert")}</ContextMenuItem>
        ) : null}
        {canRebase && !commit.onCurrentBranch ? (
          <ContextMenuItem onClick={() => onAction({ type: "rebase", commit })}>
            <GitBranchIcon />{t("git.ui.rebase_onto")}</ContextMenuItem>
        ) : null}
        {canRebase && commit.onCurrentBranch && !commit.refs.some((ref) => ref.kind === "head") ? (
          <ContextMenuItem onClick={() => onAction({ type: "interactive", commit })}>
            <ListOrderedIcon />{t("git.ui.interactive_rebase")}</ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => onAction({ type: "branch", commit })}>
          <GitBranchIcon />{t("git.ui.create_branch")}</ContextMenuItem>
        <ContextMenuItem onClick={() => onAction({ type: "tag", commit })}>
          <TagIcon />{t("git.ui.create_tag")}</ContextMenuItem>
        <ContextMenuItem onClick={() => onAction({ type: "patch", commit })}>
          <FileDiffIcon />{t("git.ui.create_patch")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CopyIcon />{t("git.ui.copy")}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem onClick={() => void copyText(commit.authorName, t("git.ui.copied_author"))}>
              <UserIcon />{t("git.ui.author")}</ContextMenuItem>
            {commit.authorEmail ? (
              <ContextMenuItem onClick={() => void copyText(commit.authorEmail, t("git.ui.copied_email"))}>
                <MailIcon />{t("git.ui.email")}</ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => void copyText(commit.id, t("git.ui.copied_commit_hash"))}>
              <HashIcon />{t("git.ui.hash")}</ContextMenuItem>
            {message ? (
              <ContextMenuItem onClick={() => void copyText(message, t("git.ui.copied_message"))}>
                <MessageSquareTextIcon />{t("git.ui.message")}</ContextMenuItem>
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
  useTranslation();
  const commits = getCommits();
  const canCherryPick = commits.every((commit) => !commit.onCurrentBranch);
  const canRevert = commits.every((commit) => commit.onCurrentBranch);
  return (
    <>
      {commits.length === 2 ? (
        <ContextMenuItem onClick={() => onAction({ type: "compare", commits })}>
          <ArrowLeftRightIcon />{t("git.ui.compare")}</ContextMenuItem>
      ) : null}
      {canCherryPick ? (
        <ContextMenuItem onClick={() => onAction({ type: "cherry-pick-many", commits })}>
          <CopyPlusIcon />{t("git.ui.cherry_pick")}</ContextMenuItem>
      ) : null}
      {canRevert ? (
        <ContextMenuItem onClick={() => onAction({ type: "revert-many", commits })}>
          <Undo2Icon />{t("git.ui.revert")}</ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onAction({ type: "copy-hashes", commits })}>
        <HashIcon />{t("git.ui.copy_hashes")}</ContextMenuItem>
    </>
  );
}

function CommitRefs({ refs }: { refs: CommitRef[] }) {
  useTranslation();
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
  useTranslation();
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
