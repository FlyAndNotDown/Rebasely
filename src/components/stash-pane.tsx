import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useGit } from "@/state/git-context";
import type { StashInfo } from "@/types/git";

export function StashPane() {
  const { stashes, stashSave, stashApply, stashPop, stashDrop } = useGit();
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [dropping, setDropping] = useState<StashInfo | null>(null);

  function submitStash() {
    void stashSave(message.trim(), includeUntracked);
    setMessage("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {stashes.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">No stashes yet</p>
        ) : (
          stashes.map((stash) => (
            <div
              key={`${stash.index}:${stash.id}`}
              className="flex items-start gap-2 rounded-md px-1.5 py-2 hover:bg-muted/70"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{stash.message || "(no message)"}</div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <span>{`stash@{${stash.index}}`}</span>
                  <span>{stash.id.slice(0, 7)}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void stashApply(stash.index)}
              >
                Apply
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void stashPop(stash.index)}
              >
                Pop
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setDropping(stash)}
              >
                Drop
              </Button>
            </div>
          ))
        )}
      </div>

      <form
        className="shrink-0 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitStash();
        }}
      >
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Stash message"
          className="min-h-16 resize-none"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
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
          <Button type="submit">Stash changes</Button>
        </div>
      </form>

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
