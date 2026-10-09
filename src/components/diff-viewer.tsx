import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Columns2Icon, PilcrowIcon } from "lucide-react";
import { ConflictEditor } from "@/components/conflict-editor";
import { ImageDiff, isImagePath } from "@/components/image-diff";
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
import { changeRange, hunkChanges, isChange, lineRefs, splitRows, type SplitRow } from "@/lib/diff-select";
import {
  diffLineSpans,
  languageFor,
  styleSpans,
  textColumns,
  type StyledSpan,
  type TextSpan,
  type TokenRange,
} from "@/lib/diff-text";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useGitPick, useGitSelect } from "@/state/git-context";
import type { DiffLine, FileDiff, ImageSource, LineAction, LineRef } from "@/types/git";

type Highlighter = (lines: { kind: string; text: string }[], language: string) => TokenRange[][] | null;
let loadedHighlighter: Highlighter | null = null;
function loadHighlighter(): Promise<Highlighter> {
  return import("@/lib/highlight").then((module) => (loadedHighlighter = module.highlightDiff));
}

/** Syntax ranges per line, once the highlighter has loaded; null for unknown languages. */
function useSyntaxRanges(diff: FileDiff, spans: TextSpan[][]) {
  const language = languageFor(diff.path);
  const [highlighter, setHighlighter] = useState<Highlighter | null>(() => loadedHighlighter);
  useEffect(() => {
    if (!language || highlighter) return;
    let live = true;
    void loadHighlighter().then((next) => {
      if (live) setHighlighter(() => next);
    });
    return () => {
      live = false;
    };
  }, [highlighter, language]);
  return useMemo(() => {
    if (!language || !highlighter) return null;
    const texts = diff.lines.map((line, index) => ({
      kind: line.kind,
      text: (spans[index] ?? []).map((span) => span.text).join(""),
    }));
    return highlighter(texts, language);
  }, [diff, highlighter, language, spans]);
}

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
    prefs,
    applyLines,
    setDiffOptions,
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
    "prefs",
    "applyLines",
    "setDiffOptions",
  ]);
  const ignoreWhitespace = prefs.diffIgnoreWhitespace;
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
    // A whitespace-blind diff cannot be turned back into a patch that applies.
    if (ignoreWhitespace || !changePath || !changeKind || !LINE_KINDS.has(changeKind)) return undefined;
    return {
      staged: changeStaged,
      allowDiscard: !changeStaged && changeKind !== "untracked",
      onApply: (action, lines) => applyLines(changePath, changeStaged, action, lines),
    };
  }, [applyLines, changeKind, changePath, changeStaged, ignoreWhitespace]);
  const textual = Boolean(diff && !diff.binary && !conflicted);
  let imageSource: ImageSource | null = null;
  if (diff?.binary && selection && isImagePath(diff.path)) {
    if (selection.type === "change") {
      imageSource = { kind: "workdir", path: selection.path, staged: selection.staged };
    } else if (comparing && comparison.path) {
      imageSource = {
        kind: "compare",
        base: comparison.base.rev,
        head: comparison.head.rev,
        path: comparison.path,
        oldPath: diff.oldPath,
      };
    } else if (selection.type === "stash" && selection.path) {
      imageSource = { kind: "stash", oid: selection.id, path: selection.path };
    } else if (selection.type === "commit" && selection.path) {
      imageSource = { kind: "commit", oid: selection.id, path: selection.path, oldPath: diff.oldPath };
    }
  }

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
        <div className="flex shrink-0 items-center gap-1">
          {selection.type === "change" ? (
            <span className="mr-1 text-[11px] text-muted-foreground">
              {selection.staged ? "Staged" : "Unstaged"}
            </span>
          ) : null}
          {textual ? (
            <>
              <Button
                type="button"
                size="icon-xs"
                variant={prefs.diffSplit ? "secondary" : "ghost"}
                aria-pressed={prefs.diffSplit}
                aria-label="Side by side"
                title="Side by side"
                onClick={() => void setDiffOptions({ split: !prefs.diffSplit })}
              >
                <Columns2Icon />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant={ignoreWhitespace ? "secondary" : "ghost"}
                aria-pressed={ignoreWhitespace}
                aria-label="Hide whitespace changes"
                title={
                  ignoreWhitespace
                    ? "Whitespace changes are hidden; line staging is off until they are shown"
                    : "Hide whitespace changes"
                }
                onClick={() => void setDiffOptions({ ignoreWhitespace: !ignoreWhitespace })}
              >
                <PilcrowIcon />
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {conflicted && selection.type === "change" ? (
        <ConflictEditor
          key={`${snapshot?.repo.path ?? ""}:${selection.path}`}
          repoPath={snapshot?.repo.path ?? ""}
          path={selection.path}
          rebasing={snapshot?.repo.operation?.kind === "rebase"}
        />
      ) : imageSource ? (
        <ImageDiff source={imageSource} />
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
  const split = useGitSelect((state) => state.prefs.diffSplit);
  const lineSpans = useMemo(() => diffLineSpans(diff.lines), [diff]);
  const syntax = useSyntaxRanges(diff, lineSpans);
  const widest = useMemo(
    () => diff.lines.reduce((max, line) => Math.max(max, textColumns(line.content)), 0),
    [diff],
  );
  const hunks = useMemo(() => hunkChanges(diff.lines), [diff]);
  const pairs = useMemo(() => (split ? splitRows(diff.lines) : null), [diff, split]);
  const rows = useWindowedRows(pairs ? pairs.length : diff.lines.length, DIFF_ROW_HEIGHT);
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
  const highlighted = Boolean(syntax);

  function gutterProps(index: number) {
    const line = diff.lines[index];
    if (!lineActions || !isChange(line)) return {};
    return {
      role: "checkbox" as const,
      "aria-checked": picked.has(index),
      "aria-label": `Select line ${line.newLineno ?? line.oldLineno}`,
      onMouseDown: (event: MouseEvent) => pressLine(event, index),
      onMouseEnter: (event: MouseEvent) => enterLine(event, index),
    };
  }

  function gutterClass(index: number) {
    const selectable = Boolean(lineActions) && isChange(diff.lines[index]);
    return cn(
      "select-none",
      selectable && "cursor-pointer hover:bg-diff-hunk/15",
      picked.has(index) && "bg-diff-hunk/25",
    );
  }

  function lineText(index: number, clip = false) {
    return (
      <DiffLineText
        spans={styleSpans(lineSpans[index] ?? [], syntax?.[index])}
        kind={diff.lines[index].kind}
        clip={clip}
      />
    );
  }

  function hunkActions(index: number) {
    const hunkLines = hunks.get(index);
    if (!lineActions || !hunkLines?.length) return null;
    return (
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
    );
  }

  function unifiedRow(index: number) {
    const line = diff.lines[index];
    return (
      <div
        key={index}
        className={cn(
          "grid h-5 grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)] px-2",
          rowTone(line, highlighted),
          picked.has(index) && "shadow-[inset_3px_0_0_var(--diff-hunk)]",
        )}
      >
        <span className={cn("col-span-3 grid grid-cols-[3rem_3rem_1.25rem]", gutterClass(index))} {...gutterProps(index)}>
          <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">
            {line.kind === "hunk" ? "" : line.oldLineno ?? ""}
          </span>
          <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">
            {line.kind === "hunk" ? "" : line.newLineno ?? ""}
          </span>
          <span className={cn("text-center", markerTone(line))}>{marker(line)}</span>
        </span>
        {line.kind === "hunk" ? (
          <span className="flex min-w-0 items-center">
            <span className="whitespace-pre">{line.content}</span>
            {hunkActions(index)}
          </span>
        ) : (
          lineText(index)
        )}
      </div>
    );
  }

  function splitSide(index: number | null, side: "left" | "right") {
    if (index === null) {
      return <span className={cn("bg-muted/30", side === "right" && "border-l border-border/60")} />;
    }
    const line = diff.lines[index];
    return (
      <span
        className={cn(
          "grid min-w-0 grid-cols-[3rem_1.25rem_minmax(0,1fr)]",
          rowTone(line, highlighted),
          picked.has(index) && "shadow-[inset_3px_0_0_var(--diff-hunk)]",
          side === "right" && "border-l border-border/60",
        )}
      >
        <span className={cn("col-span-2 grid grid-cols-[3rem_1.25rem]", gutterClass(index))} {...gutterProps(index)}>
          <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">
            {(side === "left" ? line.oldLineno : line.newLineno) ?? ""}
          </span>
          <span className={cn("text-center", markerTone(line))}>{marker(line)}</span>
        </span>
        {lineText(index, true)}
      </span>
    );
  }

  function splitRow(row: SplitRow, key: number) {
    if (row.kind === "hunk") {
      return (
        <div key={key} className="flex h-5 items-center bg-muted/50 px-2 text-diff-hunk">
          <span className="w-[4.25rem] shrink-0" />
          <span className="whitespace-pre">{diff.lines[row.index].content}</span>
          {hunkActions(row.index)}
        </div>
      );
    }
    return (
      <div key={key} className="grid h-5 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] px-2">
        {splitSide(row.left, "left")}
        {splitSide(row.right, "right")}
      </div>
    );
  }

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
          style={{
            minWidth: pairs
              ? `calc(2 * (4.25rem + ${widest}ch) + 1rem)`
              : `calc(${DIFF_GUTTER} + ${widest}ch)`,
          }}
        >
          <div style={{ height: rows.before }} />
          {pairs
            ? pairs.slice(rows.start, rows.end).map((row, offset) => splitRow(row, rows.start + offset))
            : diff.lines.slice(rows.start, rows.end).map((_, offset) => unifiedRow(rows.start + offset))}
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

function rowTone(line: DiffLine, highlighted: boolean) {
  // Syntax colors replace the green and red text; the background still marks the change.
  if (line.kind === "add") return cn("bg-diff-add-bg", highlighted ? "text-foreground" : "text-diff-add");
  if (line.kind === "delete") return cn("bg-diff-del-bg", highlighted ? "text-foreground" : "text-diff-del");
  if (line.kind === "hunk") return "bg-muted/50 text-diff-hunk";
  return undefined;
}

function markerTone(line: DiffLine) {
  if (line.kind === "add") return "text-diff-add";
  if (line.kind === "delete") return "text-diff-del";
  return undefined;
}

function marker(line: DiffLine) {
  if (line.kind === "add") return "+";
  if (line.kind === "delete") return "-";
  return line.kind === "hunk" ? "" : " ";
}

function DiffLineText({ spans, kind, clip }: { spans: StyledSpan[]; kind: string; clip?: boolean }) {
  const body = spans.map((span, index) => {
    if (!span.text) return null;
    const tone = span.tone ?? (span.changed ? kind : "");
    const mark = tone === "add" ? "bg-diff-add-char" : tone === "delete" ? "bg-diff-del-char" : undefined;
    return (
      <span key={index} className={cn(mark, span.cls && `tok-${span.cls}`)}>
        {span.text}
      </span>
    );
  });
  return (
    <span className={cn("whitespace-pre", clip && "overflow-hidden")}>
      {body.every((part) => part === null) ? " " : body}
    </span>
  );
}
