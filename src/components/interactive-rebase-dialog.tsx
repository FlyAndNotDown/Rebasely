import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, gitApi } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { RebaseAction, RebaseCommit, RebaseStep } from "@/types/git";

const ACTIONS: { id: RebaseAction; label: string }[] = [
  { id: "pick", label: "Pick" },
  { id: "reword", label: "Reword" },
  { id: "squash", label: "Squash" },
  { id: "fixup", label: "Fixup" },
  { id: "drop", label: "Drop" },
];

type Step = RebaseCommit & { action: RebaseAction; message: string };

export function InteractiveRebaseDialog({
  onto,
  onOpenChange,
}: {
  onto: { id: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(onto)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {onto ? <InteractiveRebaseForm key={onto.id} onto={onto} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function InteractiveRebaseForm({
  onto,
  onOpenChange,
}: {
  onto: { id: string; label: string };
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot, rebaseInteractive } = useGitPick(["snapshot", "rebaseInteractive"]);
  const repoPath = snapshot?.repo.path;
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(Boolean(repoPath));
  const [error, setError] = useState<string | null>(null);

  // Keyed by the target commit, so this runs once per plan and starts out loading.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    void gitApi
      .rebasePlan(repoPath, onto.id)
      .then((commits) => {
        if (cancelled) return;
        setSteps(
          commits.map((commit) => ({
            ...commit,
            action: "pick",
            message: commit.summary,
          })),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onto.id, repoPath]);

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= steps.length) return;
    setSteps((current) => {
      const copy = [...current];
      const [item] = copy.splice(index, 1);
      copy.splice(next, 0, item);
      return copy;
    });
  }

  function update(id: string, patch: Partial<Step>) {
    setSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    );
  }

  const payload: RebaseStep[] = steps.map((step) => ({
    id: step.id,
    action: step.action,
    message: step.message,
  }));
  const canStart = steps.length > 0 && !loading && !error;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Interactive rebase</DialogTitle>
        <DialogDescription>
          Replay commits after <span className="font-mono text-foreground">{onto.label}</span>.
          Oldest is first. Squash and fixup fold a commit into the one above it.
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-80 space-y-2 overflow-auto pr-1">
        {loading ? <p role="status" className="text-sm text-muted-foreground">Loading commits…</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {!loading && !error && steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to rebase.</p>
        ) : null}
        {steps.map((step, index) => (
          <div key={step.id} className="rounded-md border px-2 py-2">
            <div className="flex items-center gap-2">
              <select
                aria-label={`Action for ${step.shortId}`}
                className="h-7 shrink-0 rounded-md border bg-background px-1.5 text-xs"
                value={step.action}
                onChange={(event) =>
                  update(step.id, { action: event.target.value as RebaseAction })
                }
              >
                {ACTIONS.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.label}
                  </option>
                ))}
              </select>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {step.shortId}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  step.action === "drop" && "text-muted-foreground line-through",
                )}
              >
                {step.summary || "(no message)"}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={index === 0}
                aria-label="Move up"
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={index === steps.length - 1}
                aria-label="Move down"
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
            </div>
            {step.action === "reword" || step.action === "squash" ? (
              <Textarea
                className="mt-2 min-h-16 resize-none font-mono text-xs"
                value={step.message}
                aria-label={step.action === "reword" ? "New message" : "Squash message"}
                onChange={(event) => update(step.id, { message: event.target.value })}
              />
            ) : null}
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!canStart}
          onClick={() => {
            onOpenChange(false);
            void rebaseInteractive(onto.id, payload);
          }}
        >
          Start rebase
        </Button>
      </DialogFooter>
    </>
  );
}
