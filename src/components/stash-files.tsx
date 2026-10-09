import { memo, useCallback } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fileKindClass, fileKindLabel } from "@/lib/file-kind";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { CommitFile } from "@/types/git";

export function StashFiles() {
  const { stashSelection, stashDetails, selectStashFile } = useGitPick([
    "stashSelection",
    "stashDetails",
    "selectStashFile",
  ]);
  const onSelect = useCallback(
    (path: string) => {
      if (!stashSelection) return;
      void selectStashFile(stashSelection.id, path);
    },
    [selectStashFile, stashSelection],
  );

  if (!stashSelection) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Select a stash to see its diff
      </div>
    );
  }

  if (!stashDetails || stashDetails.id !== stashSelection.id) {
    return <StashFilesSkeleton />;
  }

  if (stashDetails.files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No changes in this stash
      </div>
    );
  }

  return (
    <ScrollArea className="h-full min-h-0 min-w-0">
      <ul className="px-1 py-1">
        {stashDetails.files.map((file) => (
          <StashFileRow
            key={file.path}
            file={file}
            selected={stashSelection.path === file.path}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

function StashFilesSkeleton() {
  return (
    <div role="status" aria-label="Loading stash files" className="relative h-full min-h-0">
      <div className="absolute inset-0 overflow-hidden px-3 py-2">
        {Array.from({ length: 80 }, (_, index) => (
          <div key={index} className="flex h-7 items-center gap-2">
            <Skeleton className="h-3 w-3 shrink-0" />
            <Skeleton className="h-3 min-w-0 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

const StashFileRow = memo(function StashFileRow({
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
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
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
