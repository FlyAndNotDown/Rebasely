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
import { Input } from "@/components/ui/input";
import { useGitPick } from "@/state/git-context";

type CommitLike = { id: string; shortId: string; summary: string };

function commitSubject(summary: string) {
  return summary.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
}

export function CommitLine({ commit }: { commit?: { shortId: string; summary: string } | null }) {
  if (!commit) return null;
  const subject = commitSubject(commit.summary);
  return (
    <div className="mt-2 flex w-full min-w-0 items-baseline gap-2 font-mono text-xs">
      <span className="shrink-0 text-foreground">{commit.shortId}</span>
      {subject ? (
        <span className="min-w-0 truncate text-muted-foreground" title={subject}>
          {subject}
        </span>
      ) : null}
    </div>
  );
}

/** Creates a branch at `commit`, or at HEAD when no commit is given. */
export function CreateBranchDialog({
  open,
  onOpenChange,
  commit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commit?: CommitLike | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* The form unmounts when the dialog closes, so every open starts empty. */}
        <BranchForm commit={commit ?? null} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BranchForm({ commit, onDone }: { commit: CommitLike | null; onDone: () => void }) {
  const { createBranch } = useGitPick(["createBranch"]);
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        void createBranch(trimmed, checkout, commit?.id).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <DialogHeader className="min-w-0">
        <DialogTitle>Create branch</DialogTitle>
        <DialogDescription>
          {commit ? "Starts a branch at this commit." : "Starts a branch at the current HEAD."}
        </DialogDescription>
      </DialogHeader>
      <CommitLine commit={commit} />
      <Input
        className="mt-3 font-mono"
        autoFocus
        placeholder="foo"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Checkbox checked={checkout} onCheckedChange={(value) => setCheckout(value === true)} />
        <span>Check out after creating</span>
      </label>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || busy}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Creates a tag on `commit`, or on HEAD when no commit is given. */
export function CreateTagDialog({
  open,
  onOpenChange,
  commit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commit?: CommitLike | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <TagForm commit={commit ?? null} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function TagForm({ commit, onDone }: { commit: CommitLike | null; onDone: () => void }) {
  const { createTag } = useGitPick(["createTag"]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        void createTag(trimmed, message.trim() || undefined, commit?.id).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <DialogHeader className="min-w-0">
        <DialogTitle>Create tag</DialogTitle>
        <DialogDescription>
          {commit ? "Tags this commit." : "Tags the current commit."} A message makes it an annotated
          tag.
        </DialogDescription>
      </DialogHeader>
      <CommitLine commit={commit} />
      <Input
        className="mt-3 font-mono"
        autoFocus
        placeholder="v1.0.0"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        className="mt-3"
        placeholder="Message (optional)"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || busy}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
