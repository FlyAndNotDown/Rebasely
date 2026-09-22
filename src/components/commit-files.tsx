import { memo, useCallback } from "react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { formatAbsoluteTime } from "@/lib/format";
import { fileKindClass, fileKindLabel } from "@/lib/file-kind";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { CommitFile } from "@/types/git";

export function CommitFiles() {
  const { commitDetails, historySelection, selectCommitFile, prefs } = useGit();
  const selectedPath = historySelection?.path;
  const onSelect = useCallback(
    (path: string) => {
      if (!commitDetails) return;
      void selectCommitFile(commitDetails.commit.id, path);
    },
    [commitDetails, selectCommitFile],
  );
  if (!commitDetails) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {historySelection ? "Loading files…" : "Select a commit to see its files"}
      </div>
    );
  }
  const commit = commitDetails.commit;

  async function copyText(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(success);
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 py-2">
        <div className="text-sm font-medium">{commit.summary}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <button
            type="button"
            title="Copy author"
            className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted hover:text-foreground"
            onClick={() => void copyText(commit.authorName, "Copied author")}
          >
            <AuthorAvatar
              name={commit.authorName}
              email={commit.authorEmail}
              provider={prefs.avatarProvider}
            />
            {commit.authorName}
          </button>
          <button
            type="button"
            title="Copy time"
            className="rounded-md px-1 py-0.5 tabular-nums hover:bg-muted hover:text-foreground"
            onClick={() => void copyText(formatAbsoluteTime(commit.timestamp), "Copied time")}
          >
            {formatAbsoluteTime(commit.timestamp)}
          </button>
          <button
            type="button"
            title="Copy full hash"
            className="rounded-md px-1 py-0.5 font-mono hover:bg-muted hover:text-foreground"
            onClick={() => void copyText(commit.id, "Copied commit hash")}
          >
            {commit.shortId}
          </button>
        </div>
        {commit.body ? (
          <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {commit.body}
          </p>
        ) : null}
      </div>
      <ul className="min-h-0 flex-1 overflow-auto border-t px-1 py-1">
        {commitDetails.files.map((file) => (
          <CommitFileRow
            key={file.path}
            file={file}
            selected={selectedPath === file.path}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

const CommitFileRow = memo(function CommitFileRow({
  file,
  selected,
  onSelect,
}: {
  file: CommitFile;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
          selected && "bg-muted",
        )}
        onClick={() => onSelect(file.path)}
      >
        <span className={cn("w-3 shrink-0 font-mono text-[11px] font-medium", fileKindClass(file.kind))}>
          {fileKindLabel(file.kind)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        {file.binary ? <span className="shrink-0 text-muted-foreground">binary</span> : null}
      </button>
    </li>
  );
});
