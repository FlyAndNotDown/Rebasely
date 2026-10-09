import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ConflictEditor } from "@/components/conflict-editor";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { changeRange, hunkChanges, isChange, lineRefs } from "@/lib/diff-select";
import { diffLineSpans, textColumns, type TextSpan } from "@/lib/diff-text";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { FileDiff, LineAction, LineRef } from "@/types/git";

export type DiffSource = "changes" | "history" | "stash";

const DIFF_ROW_HEIGHT = 20;
const DIFF_GUTTER = "8.25rem";
/** File kinds whose diff lines can be staged one by one. */
const LINE_KINDS = new Set(["modified", "added", "untracked"]);
const NO_PICKS: ReadonlySet<number> = new Set();

export interface DiffLineActions {
  staged: boolean;
  allowDiscard: boolean;
  onApply: (action: LineAction, lines: LineRef[]) => Promise<boolean>;
}

export function DiffViewer({ source }: { source: DiffSource }) {
  const {
    changeSelection,
    historySelection,
    stashSelection,
    changeDiff,
    historyDiff,
    stashDiff,
    commitDetails,
    stashDetails,
    snapshot,
    comparison,
    applyLines,
  } = useGitPick([
    "changeSelection",
    "historySelection",
    "stashSelection",
    "changeDiff",
    "historyDiff",
    "stashDiff",
    "commitDetails",
    "stashDetails",
    "snapshot",
    "comparison",
    "applyLines",
  ]);
  const comparing = source === "history" && comparison != null;
  const selection = comparing
    ? comparison.path
      ? { type: "commit" as const, id: comparison.head.rev, path: comparison.path }
      : null
    : source === "changes"
      ? changeSelection
      : source === "stash"
        ? stashSelection
        : historySelection;
  const diff = source === "changes" ? changeDiff : source === "stash" ? stashDiff : historyDiff;
  const title =
    selection?.type === "change"
      ? selection.path
      : selection?.path
        ? selection.path
        : "Diff";
  const changeFile =
    source === "changes" && changeSelection
      ? (changeSelection.staged ? snapshot?.status.staged : snapshot?.status.unstaged)?.find(
          (file) => file.path === changeSelection.path,
        )
      : undefined;
  const conflicted = changeFile?.kind === "conflicted";
  const changePath = changeSelection?.path;
  const changeStaged = changeSelection?.staged ?? false;
  const changeKind = changeFile?.kind;
  const lineActions = useMemo<DiffLineActions | undefined>(() => {
    if (!changePath || !changeKind || !LINE_KINDS.has(changeKind)) return undefined;
    return {
      staged: changeStaged,
      allowDiscard: !changeStaged && changeKind !== "untracked",
      onApply: (action, lines) => applyLines(changePath, changeStaged, action, lines),
    };
  }, [applyLines, changeKind, changePath, changeStaged]);

  if (source === "stash") {
    if (!stashSelection) {
      return (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Select a stash to see its diff
        </div>
      );
    }
    if (!stashDetails || stashDetails.id !== stashSelection.id) {
      return <DiffSkeleton label="Loading files" />;
    }
    if (!stashSelection.path) {
      return (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {stashDetails.files.length === 0 ? "No changes in this stash" : "Select a file to see its diff"}
        </div>
      );
    }
  } else if (comparing && comparison.files === null) {
    return <DiffSkeleton label="Loading files" />;
  } else if (comparing && !comparison.path) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {comparison.files?.length ? "Select a file to see its diff" : "No differences"}
      </div>
    );
  } else if (!selection || (selection.type === "commit" && !selection.path)) {
    const loadingFiles =
      selection?.type === "commit" &&
      (!commitDetails || commitDetails.commit.id !== selection.id);
    if (loadingFiles) return <DiffSkeleton label="Loading files" />;
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to see its diff
      </div>
    );
  }

  if (!selection) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm">{title}</div>
          {diff?.oldPath ? (
            <div className="truncate text-[11px] text-muted-foreground">
              renamed from {diff.oldPath}
            </div>
          ) : null}
        </div>
        {selection.type === "change" ? (
          <span className="text-[11px] text-muted-foreground">
            {selection.staged ? "Staged" : "Unstaged"}
          </span>
        ) : null}
      </div>
      {conflicted && selection.type === "change" ? (
        <ConflictEditor
          key={`${snapshot?.repo.path ?? ""}:${selection.path}`}
          repoPath={snapshot?.repo.path ?? ""}
          path={selection.path}
          rebasing={snapshot?.repo.operation?.kind === "rebase"}
        />
      ) : diff?.binary ? (
        <p className="p-4 text-sm text-muted-foreground">Binary file</p>
      ) : !diff ? (
        <DiffSkeleton />
      ) : diff.lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No textual diff</p>
      ) : (
        <DiffLines
          key={`${source}:${title}`}
          diff={diff}
          lineActions={source === "changes" ? lineActions : undefined}
        />
      )}
    </div>
  );
}

export const DiffLines = memo(function DiffLines({
  diff,
  lineActions,
}: {
  diff: FileDiff;
  lineActions?: DiffLineActions;
}) {
  const lineSpans = useMemo(() => diffLineSpans(diff.lines), [diff]);
  const widest = useMemo(
    () => diff.lines.reduce((max, line) => Math.max(max, textColumns(line.content)), 0),
    [diff],
  );
  const hunks = useMemo(() => hunkChanges(diff.lines), [diff]);
  const rows = useWindowedRows(diff.lines.length, DIFF_ROW_HEIGHT);
  // Picks belong to one diff; a reloaded diff starts with none.
  const [picks, setPicks] = useState<{ diff: FileDiff; set: ReadonlySet<number>; anchor: number | null }>(
    () => ({ diff, set: NO_PICKS, anchor: null }),
  );
  const picked = picks.diff === diff ? picks.set : NO_PICKS;
  const anchor = picks.diff === diff ? picks.anchor : null;
  const drag = useRef<{ base: ReadonlySet<number>; from: number; adding: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<number[] | null>(null);

  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  function setPicked(set: ReadonlySet<number>, nextAnchor: number | null) {
    setPicks({ diff, set, anchor: nextAnchor });
  }

  function pressLine(event: MouseEvent, index: number) {
    if (!lineActions || event.button !== 0 || busy) return;
    event.preventDefault();
    if (event.shiftKey && anchor !== null) {
      setPicked(new Set([...picked, ...changeRange(diff.lines, anchor, index)]), anchor);
      return;
    }
    const adding = !picked.has(index);
    const next = new Set(picked);
    if (adding) next.add(index);
    else next.delete(index);
    drag.current = { base: picked, from: index, adding };
    setPicked(next, index);
  }

  function enterLine(event: MouseEvent, index: number) {
    const current = drag.current;
    if (!current || (event.buttons & 1) === 0) return;
    const next = new Set(current.base);
    for (const item of changeRange(diff.lines, current.from, index)) {
      if (current.adding) next.add(item);
      else next.delete(item);
    }
    setPicked(next, current.from);
  }

  async function run(action: LineAction, indices: number[]) {
    if (!lineActions || indices.length === 0) return;
    setBusy(true);
    try {
      if (await lineActions.onApply(action, lineRefs(diff.lines, indices))) setPicked(NO_PICKS, null);
    } finally {
      setBusy(false);
    }
  }

  function request(action: LineAction, indices: number[]) {
    if (action === "discard") setConfirmDiscard(indices);
    else void run(action, indices);
  }

  const forward: LineAction = lineActions?.staged ? "unstage" : "stage";
  const forwardLabel = forward === "stage" ? "Stage" : "Unstage";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {lineActions && picked.size > 0 ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {picked.size === 1 ? "1 line selected" : `${picked.size} lines selected`}
          </span>
          <Button size="xs" disabled={busy} onClick={() => request(forward, [...picked])}>
            {forwardLabel} lines
          </Button>
          {lineActions.allowDiscard ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => request("discard", [...picked])}>
              Discard lines
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setPicked(NO_PICKS, null)}>
            Clear
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1" viewportRef={rows.viewportRef}>
        <pre
          className="font-mono text-[12px] leading-5 [tab-size:4]"
          style={{ minWidth: `calc(${DIFF_GUTTER} + ${widest}ch)` }}
        >
          <div style={{ height: rows.before }} />
          {diff.lines.slice(rows.start, rows.end).map((line, offset) => {
            const index = rows.start + offset;
            const selectable = Boolean(lineActions) && isChange(line);
            const isPicked = picked.has(index);
            const hunkLines = line.kind === "hunk" ? hunks.get(index) : undefined;
            const gutter = selectable
              ? {
                  onMouseDown: (event: MouseEvent) => pressLine(event, index),
                  onMouseEnter: (event: MouseEvent) => enterLine(event, index),
                }
              : {};
            return (
              <div
                key={index}
                className={cn(
                  "grid h-5 grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)] px-2",
                  line.kind === "add" && "bg-diff-add-bg text-diff-add",
                  line.kind === "delete" && "bg-diff-del-bg text-diff-del",
                  line.kind === "hunk" && "bg-muted/50 text-diff-hunk",
                  isPicked && "shadow-[inset_3px_0_0_var(--diff-hunk)]",
                )}
              >
                <span
                  className={cn(
                    "col-span-3 grid grid-cols-[3rem_3rem_1.25rem] select-none",
                    selectable && "cursor-pointer hover:bg-diff-hunk/15",
                    isPicked && "bg-diff-hunk/25",
                  )}
                  role={selectable ? "checkbox" : undefined}
                  aria-checked={selectable ? isPicked : undefined}
                  aria-label={selectable ? `Select line ${line.newLineno ?? line.oldLineno}` : undefined}
                  {...gutter}
                >
                  <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">
                    {line.kind === "hunk" ? "" : line.oldLineno ?? ""}
                  </span>
                  <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">
                    {line.kind === "hunk" ? "" : line.newLineno ?? ""}
                  </span>
                  <span className="text-center">
                    {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : line.kind === "hunk" ? "" : " "}
                  </span>
                </span>
                {line.kind === "hunk" ? (
                  <span className="flex min-w-0 items-center">
                    <span className="whitespace-pre">{line.content}</span>
                    {lineActions && hunkLines?.length ? (
                      <span className="sticky right-2 ml-auto flex shrink-0 gap-1 pl-4 font-sans">
                        <HunkButton disabled={busy} onClick={() => request(forward, hunkLines)}>
                          {`${forwardLabel} hunk`}
                        </HunkButton>
                        {lineActions.allowDiscard ? (
                          <HunkButton disabled={busy} onClick={() => request("discard", hunkLines)}>
                            Discard hunk
                          </HunkButton>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <DiffLineText spans={lineSpans[index] ?? []} kind={line.kind} />
                )}
              </div>
            );
          })}
          <div style={{ height: rows.after }} />
          {diff.truncated ? (
            <div className="px-3 py-2 text-muted-foreground">Diff truncated</div>
          ) : null}
        </pre>
      </ScrollArea>
      <Dialog open={confirmDiscard !== null} onOpenChange={(open) => !open && setConfirmDiscard(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Discard {confirmDiscard?.length === 1 ? "this line" : `${confirmDiscard?.length ?? 0} lines`}?
            </DialogTitle>
            <DialogDescription>
              The selected changes are removed from the working tree. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscard(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const indices = confirmDiscard ?? [];
                setConfirmDiscard(null);
                void run("discard", indices);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function HunkButton({
  children,
  disabled,
  onClick,
}: {
  children: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="h-4 rounded-sm border border-border/70 bg-background/80 px-1.5 text-[10.5px] leading-none text-foreground hover:bg-muted disabled:opacity-50"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function DiffLineText({ spans, kind }: { spans: TextSpan[]; kind: string }) {
  const body = spans.map((span, index) => {
    if (!span.text) return null;
    const tone = span.tone ?? (span.changed ? kind : "");
    const mark = tone === "add" ? "bg-diff-add-char" : tone === "delete" ? "bg-diff-del-char" : undefined;
    return (
      <span key={index} className={mark}>
        {span.text}
      </span>
    );
  });
  return <span className="whitespace-pre">{body.every((part) => part === null) ? " " : body}</span>;
}
