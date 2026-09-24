import { useMemo } from "react";
import { ConflictEditor } from "@/components/conflict-editor";
import { DiffSkeleton } from "@/components/skeletons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { diffLineSpans, type TextSpan } from "@/lib/diff-text";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function DiffViewer() {
  const {
    view,
    changeSelection,
    historySelection,
    stashSelection,
    changeDiff,
    historyDiff,
    stashDiff,
    commitDetails,
    stashDetails,
    snapshot,
  } = useGit();
  const selection =
    view === "changes" ? changeSelection : view === "stash" ? stashSelection : historySelection;
  const diff = view === "changes" ? changeDiff : view === "stash" ? stashDiff : historyDiff;
  const title =
    selection?.type === "change"
      ? selection.path
      : selection?.path
        ? selection.path
        : "Diff";
  const lineSpans = useMemo(() => (diff ? diffLineSpans(diff.lines) : []), [diff]);
  const conflicted =
    selection?.type === "change" &&
    snapshot?.status.unstaged.some((file) => file.path === selection.path && file.kind === "conflicted");

  if (view === "stash") {
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
          repoPath={snapshot?.repo.path ?? ""}
          path={selection.path}
          rebasing={snapshot?.repo.operation?.kind === "rebase"}
        />
      ) : (
      <ScrollArea className="min-h-0 flex-1">
        {diff?.binary ? (
          <p className="p-4 text-sm text-muted-foreground">Binary file</p>
        ) : !diff ? (
          <DiffSkeleton />
        ) : diff.lines.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No textual diff</p>
        ) : (
          <pre className="min-w-max font-mono text-[12px] leading-5 [tab-size:4]">
            {diff.lines.map((line, index) => (
              <div
                key={`${line.kind}-${index}-${line.oldLineno}-${line.newLineno}`}
                className={cn(
                  "grid grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)] px-2",
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
            ))}
            {diff.truncated ? (
              <div className="px-3 py-2 text-muted-foreground">Diff truncated</div>
            ) : null}
          </pre>
        )}
      </ScrollArea>
      )}
    </div>
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

