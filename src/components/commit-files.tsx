import { memo, useCallback } from "react";
import { ArrowLeftRightIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { CommitFilesSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatAbsoluteTime } from "@/lib/format";
import { fileKindClass, fileKindLabel } from "@/lib/file-kind";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { CommitFile } from "@/types/git";

export function CommitFiles() {
  const {
    commitDetails,
    historySelection,
    selectCommitFile,
    comparison,
    swapComparison,
    closeComparison,
    selectCompareFile,
    closeCommit,
  } = useGitPick([
    "commitDetails",
    "historySelection",
    "selectCommitFile",
    "comparison",
    "swapComparison",
    "closeComparison",
    "selectCompareFile",
    "closeCommit",
  ]);
  const selectedPath = comparison ? comparison.path : historySelection?.path;
  const onSelect = useCallback(
    (path: string) => {
      if (!commitDetails) return;
      void selectCommitFile(commitDetails.commit.id, path);
    },
    [commitDetails, selectCommitFile],
  );
  if (comparison) {
    return (
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Compare</div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <HoverTip label={comparison.base.rev}>
                <span className="min-w-0 truncate font-mono">{comparison.base.label}</span>
              </HoverTip>
              <HoverTip label="Swap sides">
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  onClick={swapComparison}
                >
                  <ArrowLeftRightIcon className="size-3.5" />
                </button>
              </HoverTip>
              <HoverTip label={comparison.head.rev}>
                <span className="min-w-0 truncate font-mono">{comparison.head.label}</span>
              </HoverTip>
            </div>
          </div>
          <HoverTip label="Close compare">
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={closeComparison}
            >
              <XIcon className="size-3.5" />
            </button>
          </HoverTip>
        </div>
        {comparison.files === null ? (
          <CommitFilesSkeleton />
        ) : comparison.files.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center border-t p-4 text-sm text-muted-foreground">
            No differences
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1 border-t">
            <ul className="px-1 py-1">
              {comparison.files.map((file) => (
                <CommitFileRow
                  key={file.path}
                  file={file}
                  selected={selectedPath === file.path}
                  onSelect={selectCompareFile}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
    );
  }
  if (!commitDetails) {
    return (
      historySelection ? (
        <div className="absolute inset-0 flex flex-col">
          <CommitFilesSkeleton />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-muted-foreground">
          Select a commit to see its files
        </div>
      )
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
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <div className="shrink-0 px-3 py-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-sm font-medium">{commit.summary}</div>
          <HoverTip label="Close">
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Close" onClick={closeCommit}>
              <XIcon />
            </Button>
          </HoverTip>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <HoverTip label="Copy author">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted hover:text-foreground"
            onClick={() => void copyText(commit.authorName, "Copied author")}
          >
            <AuthorAvatar
              name={commit.authorName}
              email={commit.authorEmail}
            />
            {commit.authorName}
          </button>
          </HoverTip>
          <HoverTip label="Copy time">
          <button
            type="button"
            className="rounded-md px-1 py-0.5 tabular-nums hover:bg-muted hover:text-foreground"
            onClick={() => void copyText(formatAbsoluteTime(commit.timestamp), "Copied time")}
          >
            {formatAbsoluteTime(commit.timestamp)}
          </button>
          </HoverTip>
          <HoverTip label="Copy full hash">
          <button
            type="button"
            className="rounded-md px-1 py-0.5 font-mono hover:bg-muted hover:text-foreground"
            onClick={() => void copyText(commit.id, "Copied commit hash")}
          >
            {commit.shortId}
          </button>
          </HoverTip>
        </div>
        {commit.body ? (
          <ScrollArea
            className="mt-2 max-h-24"
            viewportClassName="h-auto max-h-24 [&>div]:h-auto! [&>div]:min-h-0!"
          >
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{commit.body}</p>
          </ScrollArea>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1 border-t">
      <ul className="px-1 py-1">
        {commitDetails.files.map((file) => (
          <CommitFileRow
            key={file.path}
            file={file}
            selected={selectedPath === file.path}
            onSelect={onSelect}
          />
        ))}
      </ul>
      </ScrollArea>
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
