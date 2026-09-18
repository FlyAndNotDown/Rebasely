import { fileName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function DiffViewer() {
  const { view, changeSelection, historySelection, changeDiff, historyDiff, commitDetails } =
    useGit();
  const selection = view === "changes" ? changeSelection : historySelection;
  const diff = view === "changes" ? changeDiff : historyDiff;
  const title =
    selection?.type === "change"
      ? selection.path
      : selection?.type === "commit"
        ? (selection.path ?? commitDetails?.commit.summary ?? "Commit")
        : "Diff";

  if (!selection) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {view === "history" ? "Select a commit to see its diff" : "Select a file to see its diff"}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {diff?.binary ? (
          <p className="p-4 text-sm text-muted-foreground">Binary file</p>
        ) : !diff || diff.lines.length === 0 ? (
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
      </div>
      {view === "history" && commitDetails && selection.type === "commit" ? (
        <CommitFiles />
      ) : null}
    </div>
  );
}

function CommitFiles() {
  const { commitDetails, historySelection, selectCommitFile } = useGit();
  if (!commitDetails) return null;
  const selectedPath = historySelection?.path;

  return (
    <div className="max-h-48 shrink-0 overflow-auto border-t">
      <div className="px-3 py-2">
        <div className="text-sm font-medium">{commitDetails.commit.summary}</div>
        <div className="text-[11px] text-muted-foreground">
          {commitDetails.commit.authorName} · {commitDetails.commit.shortId}
        </div>
        {commitDetails.commit.body ? (
          <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
            {commitDetails.commit.body}
          </p>
        ) : null}
      </div>
      <ul className="border-t px-1 py-1">
        {commitDetails.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
                selectedPath === file.path && "bg-muted",
              )}
              onClick={() => void selectCommitFile(commitDetails.commit.id, file.path)}
            >
              <span className="font-mono text-[11px] text-muted-foreground">
                {file.kind[0]?.toUpperCase()}
              </span>
              <span className="truncate font-mono">{file.path}</span>
              <span className="ml-auto truncate text-muted-foreground">
                {file.binary ? "binary" : fileName(file.path)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
