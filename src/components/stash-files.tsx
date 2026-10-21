import { memo, useCallback } from "react";
import { LayersArrowDownIcon, LayersArrowUpIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fileKindClass, fileKindLabel } from "@/lib/file-kind";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { CommitFile } from "@/types/git";

export function StashFiles() {
  const { stashSelection, stashDetails, stashes, selectStashFile, stashApply, stashPop, closeStash } = useGitPick([
    "stashSelection",
    "stashDetails",
    "stashes",
    "selectStashFile",
    "stashApply",
    "stashPop",
    "closeStash",
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
      <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Select a stash to see its diff
      </div>
    );
  }

  const ready = stashDetails?.id === stashSelection.id ? stashDetails : null;
  const listed = stashes.find((stash) => stash.id === stashSelection.id);
  const message = ready?.message || listed?.message || "(no message)";
  const count = ready?.files.length;

  return (
    <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <HoverTip label={message}>
          <span className="min-w-0 flex-1 truncate text-sm">{message}</span>
        </HoverTip>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{`stash@{${stashSelection.index}}`}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{stashSelection.id.slice(0, 7)}</span>
        {count != null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {count === 1 ? "1 file" : `${count} files`}
          </span>
        ) : null}
        <HoverTip label="Apply">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Apply"
            onClick={() => void stashApply(stashSelection.id)}
          >
            <LayersArrowDownIcon />
          </Button>
        </HoverTip>
        <HoverTip label="Pop">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Pop"
            onClick={() => void stashPop(stashSelection.id)}
          >
            <LayersArrowUpIcon />
          </Button>
        </HoverTip>
        <HoverTip label="Close">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Close" onClick={closeStash}>
            <XIcon />
          </Button>
        </HoverTip>
      </div>
      {!ready ? (
        <StashFilesSkeleton />
      ) : ready.files.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          No changes in this stash
        </div>
      ) : (
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <ul className="px-1 py-1">
            {ready.files.map((file) => (
              <StashFileRow
                key={file.path}
                file={file}
                selected={stashSelection.path === file.path}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function StashFilesSkeleton() {
  return (
    <div role="status" aria-label="Loading stash files" className="relative min-h-0 flex-1">
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
