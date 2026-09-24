import { memo, useMemo } from "react";
import { ConflictEditor } from "@/components/conflict-editor";
import { DiffSkeleton } from "@/components/skeletons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { diffLineSpans, textColumns, type TextSpan } from "@/lib/diff-text";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { FileDiff } from "@/types/git";

export type DiffSource = "changes" | "history" | "stash";

const DIFF_ROW_HEIGHT = 20;
const DIFF_GUTTER = "8.25rem";

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
  const conflicted =
    selection?.type === "change" &&
    snapshot?.status.unstaged.some((file) => file.path === selection.path && file.kind === "conflicted");

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
        <DiffLines key={`${source}:${title}`} diff={diff} />
      )}
    </div>
  );
}

export const DiffLines = memo(function DiffLines({ diff }: { diff: FileDiff }) {
  const lineSpans = useMemo(() => diffLineSpans(diff.lines), [diff]);
  const widest = useMemo(
    () => diff.lines.reduce((max, line) => Math.max(max, textColumns(line.content)), 0),
    [diff],
  );
  const rows = useWindowedRows(diff.lines.length, DIFF_ROW_HEIGHT);

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={rows.viewportRef}>
      <pre
        className="font-mono text-[12px] leading-5 [tab-size:4]"
        style={{ minWidth: `calc(${DIFF_GUTTER} + ${widest}ch)` }}
      >
        <div style={{ height: rows.before }} />
        {diff.lines.slice(rows.start, rows.end).map((line, offset) => {
          const index = rows.start + offset;
          return (
            <div
              key={index}
              className={cn(
                "grid h-5 grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)] px-2",
                line.kind === "add" && "bg-diff-add-bg text-diff-add",
                line.kind === "delete" && "bg-diff-del-bg text-diff-del",
                line.kind === "hunk" && "bg-muted/50 text-diff-hunk",
              )}
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
              {line.kind === "hunk" ? (
                <span className="whitespace-pre">{line.content}</span>
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
  );
});

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
