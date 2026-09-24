import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { StashInfo } from "@/types/git";

export function StashPane() {
  const { stashes, stashSelection, selectStash, stashApply, stashPop, stashDrop } = useGit();
  const [dropping, setDropping] = useState<StashInfo | null>(null);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportClassName="[&>div]:w-full [&>div]:min-w-0 [&>div]:max-w-full"
      >
        {stashes.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">No stashes yet</p>
        ) : (
          <div className="w-full min-w-0 px-2 py-1">
            {stashes.map((stash) => (
              <StashRow
                key={stash.id}
                stash={stash}
                selected={stashSelection?.id === stash.id}
                onSelect={() => void selectStash(stash)}
                onApply={() => void stashApply(stash.index)}
                onPop={() => void stashPop(stash.index)}
                onDrop={() => setDropping(stash)}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <Dialog
        open={!!dropping}
        onOpenChange={(open) => {
          if (!open) setDropping(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Drop stash?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-mono">{dropping ? `stash@{${dropping.index}}` : ""}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDropping(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (dropping) void stashDrop(dropping.index);
                setDropping(null);
              }}
            >
              Drop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StashComposer() {
  const { stashSave } = useGit();
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [saving, setSaving] = useState(false);

  async function submitStash() {
    if (saving) return;
    const next = message;
    setSaving(true);
    try {
      if (await stashSave(next.trim(), includeUntracked)) {
        setMessage((current) => (current === next ? "" : current));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="shrink-0 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submitStash();
      }}
    >
      <Textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Stash message"
        className="min-h-16 resize-none"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-untracked"
            checked={includeUntracked}
            onCheckedChange={(value) => setIncludeUntracked(value === true)}
          />
          <Label htmlFor="include-untracked" className="font-normal text-muted-foreground">
            Include untracked
          </Label>
        </div>
        <Button type="submit" disabled={saving}>
          Stash changes
        </Button>
      </div>
    </form>
  );
}

function StashRow({
  stash,
  selected,
  onSelect,
  onApply,
  onPop,
  onDrop,
}: {
  stash: StashInfo;
  selected: boolean;
  onSelect: () => void;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}) {
  const label = stash.message || "(no message)";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={label}
          className={cn(
            "block w-full min-w-0 overflow-hidden rounded-md px-1.5 py-2 text-left hover:bg-muted/70",
            selected && "bg-muted",
          )}
          onClick={onSelect}
        >
          <div className="truncate text-sm">{label}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span className="shrink-0">{`stash@{${stash.index}}`}</span>
            <span className="min-w-0 truncate">{stash.id.slice(0, 7)}</span>
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-36">
        <ContextMenuItem onClick={onApply}>Apply</ContextMenuItem>
        <ContextMenuItem onClick={onPop}>Pop</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDrop}>
          Drop
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
