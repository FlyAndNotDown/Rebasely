import { formatNumber, t, useTranslation } from "@/i18n";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Columns2Icon, ExternalLinkIcon, PilcrowIcon, SquarePenIcon, XIcon } from "lucide-react";
import { ConflictEditor } from "@/components/conflict-editor";
import { ImageDiff, isImagePath } from "@/components/image-diff";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
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
  hunkLabel,
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
import type { DiffLine, FileDiff, FileSource, LineAction, LineRef } from "@/types/git";

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
const DIFF_GUTTER = "5.25rem";
/** File kinds whose diff lines can be staged one by one. */
const LINE_KINDS = new Set(["modified", "added", "untracked"]);
const NO_PICKS: ReadonlySet<number> = new Set();

export interface DiffLineActions {
  staged: boolean;
  allowDiscard: boolean;
  onApply: (action: LineAction, lines: LineRef[]) => Promise<boolean>;
}

export function DiffViewer({ source }: { source: DiffSource }) {
  useTranslation();
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
    openDifftool,
    openInEditor,
    closeFile,
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
    "openDifftool",
    "openInEditor",
    "closeFile",
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
        : t("git-files.diff");
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
  let fileSource: FileSource | null = null;
  if (diff && selection) {
    if (selection.type === "change") {
      fileSource = { kind: "workdir", path: selection.path, staged: selection.staged };
    } else if (comparing && comparison.path) {
      fileSource = {
        kind: "compare",
        base: comparison.base.rev,
        head: comparison.head.rev,
        path: comparison.path,
        oldPath: diff.oldPath,
      };
    } else if (selection.type === "stash" && selection.path) {
      fileSource = { kind: "stash", oid: selection.id, path: selection.path };
    } else if (selection.type === "commit" && selection.path) {
      fileSource = { kind: "commit", oid: selection.id, path: selection.path, oldPath: diff.oldPath };
    }
  }
  const imageSource = diff?.binary && isImagePath(diff.path) ? fileSource : null;

  if (source === "stash") {
    if (!stashSelection) {
      return (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("git-files.selectStash")}
        </div>
      );
    }
    if (!stashDetails || stashDetails.id !== stashSelection.id) {
      return <DiffSkeleton fill label={t("git-files.loadingFiles")} />;
    }
    if (!stashSelection.path) {
      return (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {stashDetails.files.length === 0 ? t("git-files.emptyStash") : t("git-files.selectDiff")}
        </div>
      );
    }
  } else if (comparing && comparison.files === null) {
    return <DiffSkeleton fill label={t("git-files.loadingFiles")} />;
  } else if (comparing && !comparison.path) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {comparison.files?.length ? t("git-files.selectDiff") : t("git-files.noDifferences")}
      </div>
    );
  } else if (!selection || (selection.type === "commit" && !selection.path)) {
    const loadingFiles =
      selection?.type === "commit" &&
      (!commitDetails || commitDetails.commit.id !== selection.id);
    if (loadingFiles) return <DiffSkeleton fill label={t("git-files.loadingFiles")} />;
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {t("git-files.selectDiff")}
      </div>
    );
  }

  if (!selection) return null;

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm">{title}</div>
          {diff?.oldPath ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {t("git-files.renamedFrom", { path: diff.oldPath })}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selection.type === "change" ? (
            <span className="mr-1 text-[11px] text-muted-foreground">
              {selection.staged ? t("git-files.staged") : t("git-files.unstaged")}
            </span>
          ) : null}
          {textual ? (
            <>
              <HoverTip label={t("git-files.sideBySide")}>
                <Button
                  type="button"
                  size="icon-xs"
                  variant={prefs.diffSplit ? "secondary" : "ghost"}
                  aria-pressed={prefs.diffSplit}
                  aria-label={t("git-files.sideBySide")}
                  onClick={() => void setDiffOptions({ split: !prefs.diffSplit })}
                >
                  <Columns2Icon />
                </Button>
              </HoverTip>
              <HoverTip
                label={
                  ignoreWhitespace
                    ? t("git-files.whitespaceHint")
                    : t("git-files.hideWhitespace")
                }
              >
                <Button
                  type="button"
                  size="icon-xs"
                  variant={ignoreWhitespace ? "secondary" : "ghost"}
                  aria-pressed={ignoreWhitespace}
                  aria-label={t("git-files.hideWhitespace")}
                  onClick={() => void setDiffOptions({ ignoreWhitespace: !ignoreWhitespace })}
                >
                  <PilcrowIcon />
                </Button>
              </HoverTip>
            </>
          ) : null}
          {fileSource && !conflicted && changeKind !== "untracked" ? (
            <HoverTip label={t("git-files.openDiffTool")}>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t("git-files.openDiffTool")}
                onClick={() => fileSource && void openDifftool(fileSource)}
              >
                <ExternalLinkIcon />
              </Button>
            </HoverTip>
          ) : null}
          {selection.path ? (
            <HoverTip label={t("git-files.openEditor")}>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t("git-files.openEditor")}
                onClick={() => {
                  const line = diff?.lines.find((item) => item.newLineno)?.newLineno ?? null;
                  void openInEditor(selection.path, line);
                }}
              >
                <SquarePenIcon />
              </Button>
            </HoverTip>
          ) : null}
          <HoverTip label={t("git-files.close")}>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("git-files.close")}
              onClick={() => closeFile(source)}
            >
              <XIcon />
            </Button>
          </HoverTip>
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
        <ImageDiff repoPath={snapshot?.repo.path ?? ""} source={imageSource} refreshIdentity={diff} />
      ) : diff?.binary ? (
        <p className="p-4 text-sm text-muted-foreground">{t("git-files.binaryFile")}</p>
      ) : !diff ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <DiffSkeleton fill />
        </div>
      ) : diff.lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t("git-files.noTextDiff")}</p>
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
  useTranslation();
  const split = useGitSelect((state) => state.prefs.diffSplit);
  const lineSpans = useMemo(() => diffLineSpans(diff.lines), [diff]);
  const syntax = useSyntaxRanges(diff, lineSpans);
  const widest = useMemo(
    () =>
      diff.lines.reduce(
        (max, line) => Math.max(max, textColumns(line.kind === "hunk" ? hunkLabel(line.content) : line.content)),
        0,
      ),
    [diff],
  );
  const hunks = useMemo(() => hunkChanges(diff.lines), [diff]);
  const pairs = useMemo(() => (split ? splitRows(diff.lines) : null), [diff, split]);
  const [paneWidth, setPaneWidth] = useState(0);
  const [ch, setCh] = useState(7.2);
  const charsPerSide = useMemo(() => {
    if (!split || paneWidth <= 0) return 0;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const side = (paneWidth - 16) / 2 - 4.25 * rem;
    // One column short, so a rounding miss makes the row taller instead of overlapping the next one.
    return Math.max(1, Math.floor(side / ch) - 1);
  }, [ch, paneWidth, split]);
  const splitHeights = useMemo(() => {
    if (!pairs) return null;
    return pairs.map((row) => {
      if (row.kind === "hunk" || charsPerSide <= 0) return DIFF_ROW_HEIGHT;
      const wraps = (index: number | null) => {
        if (index === null) return 1;
        return Math.max(1, Math.ceil(textColumns(diff.lines[index].content) / charsPerSide));
      };
      return Math.max(wraps(row.left), wraps(row.right)) * DIFF_ROW_HEIGHT;
    });
  }, [charsPerSide, diff, pairs]);
  const rows = useWindowedRows(
    splitHeights ?? (pairs ? pairs.length : diff.lines.length),
    splitHeights ? 8 : DIFF_ROW_HEIGHT,
  );
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

  useLayoutEffect(() => {
    const node = rows.viewport;
    if (!node || !split) return;
    const measure = () => {
      const pre = node.querySelector("pre");
      const width = pre?.clientWidth || node.clientWidth;
      setPaneWidth((current) => (current === width ? current : width));
      if (!pre) return;
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      context.font = getComputedStyle(pre).font;
      const measured = context.measureText("0").width;
      if (measured > 0) setCh((current) => (Math.abs(current - measured) < 0.05 ? current : measured));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rows.viewport, split]);

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
  const highlighted = Boolean(syntax);

  function gutterProps(index: number) {
    const line = diff.lines[index];
    if (!lineActions || !isChange(line)) return {};
    return {
      role: "checkbox" as const,
      "aria-checked": picked.has(index),
      "aria-label": t("git-files.selectLine", { number: line.newLineno ?? line.oldLineno }),
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

  function lineText(index: number, wrap = false) {
    return (
      <DiffLineText
        spans={styleSpans(lineSpans[index] ?? [], syntax?.[index])}
        kind={diff.lines[index].kind}
        wrap={wrap}
      />
    );
  }

  function hunkActions(index: number) {
    const hunkLines = hunks.get(index);
    if (!lineActions || !hunkLines?.length) return null;
    return (
      <span className="sticky right-2 ml-auto flex shrink-0 gap-1 pl-4 font-sans">
        <HunkButton disabled={busy} onClick={() => request(forward, hunkLines)}>
          {t(forward === "stage" ? "git-files.stageHunk" : "git-files.unstageHunk")}
        </HunkButton>
        {lineActions.allowDiscard ? (
          <HunkButton disabled={busy} onClick={() => request("discard", hunkLines)}>
            {t("git-files.discardHunk")}
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
          "grid h-5 grid-cols-[3rem_1.25rem_minmax(0,1fr)] px-2",
          rowTone(line, highlighted),
          picked.has(index) && "shadow-[inset_3px_0_0_var(--diff-hunk)]",
        )}
      >
        <span className={cn("col-span-2 grid grid-cols-[3rem_1.25rem]", gutterClass(index))} {...gutterProps(index)}>
          <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">
            {line.kind === "hunk" ? "" : (line.newLineno ?? line.oldLineno ?? "")}
          </span>
          <span className={cn("text-center", markerTone(line))}>{marker(line)}</span>
        </span>
        {line.kind === "hunk" ? (
          <span className="flex min-w-0 items-center">
            <span className="whitespace-pre">{hunkLabel(line.content)}</span>
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
      return <span className={cn("h-full min-h-5 bg-muted/30", side === "right" && "border-l border-border")} />;
    }
    const line = diff.lines[index];
    return (
      <span
        className={cn(
          "grid h-full min-h-5 min-w-0 grid-cols-[3rem_1.25rem_minmax(0,1fr)] items-start",
          rowTone(line, highlighted),
          picked.has(index) && "shadow-[inset_3px_0_0_var(--diff-hunk)]",
          side === "right" && "border-l border-border",
        )}
      >
        <span
          className={cn("col-span-2 grid grid-cols-[3rem_1.25rem] self-start", gutterClass(index))}
          {...gutterProps(index)}
        >
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
          <span className="min-w-0 flex-1 truncate">{hunkLabel(diff.lines[row.index].content)}</span>
          {hunkActions(row.index)}
        </div>
      );
    }
    return (
      <div
        key={key}
        className="grid min-h-5 w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] px-2"
        style={splitHeights ? { height: splitHeights[key] } : undefined}
      >
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
            {t("git-files.selectedLines", { count: picked.size, value: formatNumber(picked.size) })}
          </span>
          <Button size="xs" disabled={busy} onClick={() => request(forward, [...picked])}>
            {t(forward === "stage" ? "git-files.stageLines" : "git-files.unstageLines")}
          </Button>
          {lineActions.allowDiscard ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => request("discard", [...picked])}>
              {t("git-files.discardLines")}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setPicked(NO_PICKS, null)}>
            {t("git-files.clear")}
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1" gutter={false} viewportRef={rows.viewportRef}>
        <pre
          className={cn("font-mono text-[12px] leading-5 [tab-size:4]", pairs && "w-full")}
          style={pairs ? undefined : { minWidth: `calc(${DIFF_GUTTER} + ${widest}ch)` }}
        >
          <div style={{ height: rows.before }} />
          {pairs
            ? pairs.slice(rows.start, rows.end).map((row, offset) => splitRow(row, rows.start + offset))
            : diff.lines.slice(rows.start, rows.end).map((_, offset) => unifiedRow(rows.start + offset))}
          <div style={{ height: rows.after }} />
          {diff.truncated ? (
            <div className="px-3 py-2 text-muted-foreground">{t("git-files.truncated")}</div>
          ) : null}
        </pre>
      </ScrollArea>
      <Dialog open={confirmDiscard !== null} onOpenChange={(open) => !open && setConfirmDiscard(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("git-files.discardLineCount", { count: confirmDiscard?.length ?? 0, value: formatNumber(confirmDiscard?.length ?? 0) })}
            </DialogTitle>
            <DialogDescription>
              {t("git-files.discardDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDiscard(null)}>
              {t("git-files.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const indices = confirmDiscard ?? [];
                setConfirmDiscard(null);
                void run("discard", indices);
              }}
            >
              {t("git-files.discard")}
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

function DiffLineText({ spans, kind, wrap }: { spans: StyledSpan[]; kind: string; wrap?: boolean }) {
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
    <span className={cn("min-w-0", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
      {body.every((part) => part === null) ? " " : body}
    </span>
  );
}
