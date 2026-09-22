import { DiffSkeleton } from "@/components/skeletons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function DiffViewer() {
  const { view, changeSelection, historySelection, changeDiff, historyDiff, commitDetails } = useGit();
  const selection = view === "changes" ? changeSelection : historySelection;
  const diff = view === "changes" ? changeDiff : historyDiff;
  const title =
    selection?.type === "change"
      ? selection.path
      : selection?.type === "commit"
        ? (selection.path ?? "Diff")
        : "Diff";

  if (!selection || (selection.type === "commit" && !selection.path)) {
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
      <ScrollArea className="min-h-0 flex-1">
        {diff?.binary ? (
          <p className="p-4 text-sm text-muted-foreground">Binary file</p>
        ) : !diff ? (
          <DiffSkeleton />
        ) : diff.lines.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No textual diff</p>
        ) : (
          <pre className="min-w-max font-mono text-[12px] leading-5">
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
                <span className="whitespace-pre">
                  {line.kind === "hunk" ? line.content : line.content || " "}
                </span>
              </div>
            ))}
            {diff.truncated ? (
              <div className="px-3 py-2 text-muted-foreground">Diff truncated</div>
            ) : null}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}
