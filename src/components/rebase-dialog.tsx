import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGitPick } from "@/state/git-context";

export function RebaseOntoDialog({
  target,
  onOpenChange,
}: {
  target: { onto: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot, rebaseOnto } = useGitPick(["snapshot", "rebaseOnto"]);
  const branch = snapshot?.repo.currentBranch;

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rebase onto {target?.label}?</DialogTitle>
          <DialogDescription>
            Replay commits from{" "}
            <span className="font-mono text-foreground">{branch ?? "the current branch"}</span> that
            are not in <span className="font-mono text-foreground">{target?.label}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              const next = target;
              if (!next) return;
              onOpenChange(false);
              void rebaseOnto(next.onto, next.label);
            }}
          >
            Rebase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MergeDialog({
  target,
  onOpenChange,
}: {
  target: { onto: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot, mergeRef } = useGitPick(["snapshot", "mergeRef"]);
  const branch = snapshot?.repo.currentBranch;

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge {target?.label}?</DialogTitle>
          <DialogDescription>
            Merge it into{" "}
            <span className="font-mono text-foreground">{branch ?? "the current branch"}</span>.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              const next = target;
              if (!next) return;
              onOpenChange(false);
              void mergeRef(next.onto, next.label);
            }}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const OPERATION_LABEL: Record<string, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

export function RebaseBanner() {
  const { snapshot, operationContinue, operationAbort, rebaseSkip, setView } = useGitPick([
    "snapshot",
    "operationContinue",
    "operationAbort",
    "rebaseSkip",
    "setView",
  ]);
  const operation = snapshot?.repo.operation;
  if (!operation) return null;
  const conflicted = (snapshot?.status.unstaged ?? []).some((file) => file.kind === "conflicted");
  const progress =
    operation.step && operation.total ? ` · ${operation.step} of ${operation.total}` : "";
  const title = OPERATION_LABEL[operation.kind] ?? "Operation";

  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/60 px-3 py-1.5">
      <p className="min-w-0 flex-1 truncate text-sm">
        {title} in progress{progress}
        {conflicted ? ". Resolve conflicts on Changes, then continue." : "."}
      </p>
      <Button
        type="button"
        size="xs"
        disabled={conflicted}
        onClick={() => {
          setView("changes");
          void operationContinue();
        }}
      >
        Continue
      </Button>
      {operation.kind === "rebase" ? (
        <Button type="button" size="xs" variant="outline" onClick={() => void rebaseSkip()}>
          Skip
        </Button>
      ) : null}
      <Button type="button" size="xs" variant="destructive" onClick={() => void operationAbort()}>
        Abort
      </Button>
    </div>
  );
}
