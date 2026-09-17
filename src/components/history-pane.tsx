import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function HistoryPane() {
  const { commits, selection, selectCommit } = useGit();
  const selectedId = selection?.type === "commit" ? selection.id : null;

  if (commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No commits yet
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto py-1">
      {commits.map((commit) => (
        <button
          key={commit.id}
          type="button"
          className={cn(
            "flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted/70",
            selectedId === commit.id && "bg-muted",
          )}
          onClick={() => void selectCommit(commit.id)}
        >
          <span className="line-clamp-2 text-sm">{commit.summary || "(no message)"}</span>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{commit.authorName}</span>
            <span className="font-mono">{commit.shortId}</span>
            <span className="ml-auto shrink-0">{formatRelativeTime(commit.timestamp)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
