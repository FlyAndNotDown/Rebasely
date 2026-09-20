import { useMemo, useState, type ReactNode } from "react";
import { ChevronDownIcon, MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Textarea } from "@/components/ui/textarea";
import { fileName, parentPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { FileStatus, WorkspaceSnapshot } from "@/types/git";

function kindLabel(kind: string): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
    case "typechange":
      return "T";
    default:
      return "M";
  }
}

function kindClass(kind: string): string {
  switch (kind) {
    case "added":
    case "untracked":
      return "text-diff-add";
    case "deleted":
    case "conflicted":
      return "text-diff-del";
    case "renamed":
      return "text-diff-hunk";
    default:
      return "text-amber-600 dark:text-amber-400";
  }
}

function FileRow({
  file,
  active,
  onSelect,
  onPrimary,
  onDiscard,
  primaryLabel,
}: {
  file: FileStatus;
  active: boolean;
  onSelect: () => void;
  onPrimary: () => void;
  onDiscard?: () => void;
  primaryLabel: string;
}) {
  const directory = parentPath(file.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted/70",
            active && "bg-muted",
          )}
        >
          <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "w-3 shrink-0 font-mono text-[11px] font-medium",
                  kindClass(file.kind),
                )}
              >
                {kindLabel(file.kind)}
              </span>
              <span className="truncate">{fileName(file.path)}</span>
            </div>
            {directory ? (
              <div className="truncate pl-5 font-mono text-[11px] text-muted-foreground">
                {directory}
              </div>
            ) : null}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100"
            onClick={onPrimary}
            aria-label={primaryLabel}
          >
            {file.staged ? <MinusIcon /> : <PlusIcon />}
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onPrimary}>{primaryLabel}</ContextMenuItem>
        <ContextMenuItem onClick={onSelect}>View diff</ContextMenuItem>
        {onDiscard ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDiscard}>
              Discard
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function headCommitMessage(snapshot: WorkspaceSnapshot) {
  const head = snapshot.headCommit;
  if (!head) return "";
  return head.body ? `${head.summary}\n\n${head.body}` : head.summary;
}

export function ChangesPane() {
  const { snapshot, changeSelection, selectChange, stage, unstage, discard, commit } = useGit();
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<string[] | null>(null);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const staged = snapshot?.status.staged ?? [];
  const unstaged = snapshot?.status.unstaged ?? [];
  const selectedChange = changeSelection;
  const canAmend = Boolean(snapshot?.headCommit);
  const canCommit = message.trim().length > 0 && (amend ? canAmend : staged.length > 0);

  const counts = useMemo(
    () => ({ staged: staged.length, unstaged: unstaged.length }),
    [staged.length, unstaged.length],
  );

  function submitCommit() {
    if (!canCommit) return;
    const next = message;
    const nextAmend = amend;
    setMessage("");
    setAmend(false);
    void commit(next, nextAmend);
  }

  function toggleAmend(next: boolean) {
    setAmend(next);
    if (next && snapshot && !message.trim()) {
      setMessage(headCommitMessage(snapshot));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        <Section
          title="Staged"
          count={counts.staged}
          open={stagedOpen}
          onOpenChange={setStagedOpen}
          actionLabel="Unstage all"
          onAction={
            staged.length ? () => void unstage(staged.map((file) => file.path)) : undefined
          }
        >
          {staged.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">No staged files</p>
          ) : (
            staged.map((file) => (
              <FileRow
                key={`staged:${file.path}`}
                file={file}
                active={selectedChange?.path === file.path && selectedChange.staged}
                onSelect={() => void selectChange(file.path, true)}
                onPrimary={() => void unstage([file.path])}
                primaryLabel="Unstage"
              />
            ))
          )}
        </Section>

        <Section
          title="Changes"
          count={counts.unstaged}
          open={changesOpen}
          onOpenChange={setChangesOpen}
          actionLabel="Stage all"
          onAction={
            unstaged.length ? () => void stage(unstaged.map((file) => file.path)) : undefined
          }
        >
          {unstaged.length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">Working tree is clean</p>
          ) : (
            unstaged.map((file) => (
              <FileRow
                key={`unstaged:${file.path}`}
                file={file}
                active={selectedChange?.path === file.path && !selectedChange.staged}
                onSelect={() => void selectChange(file.path, false)}
                onPrimary={() => void stage([file.path])}
                onDiscard={() => setDiscardTarget([file.path])}
                primaryLabel="Stage"
              />
            ))
          )}
        </Section>
      </div>

      <form
        className="shrink-0 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitCommit();
        }}
      >
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          className="min-h-20 resize-none"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              submitCommit();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!unstaged.length}
            onClick={() => setDiscardTarget(unstaged.map((file) => file.path))}
          >
            <Undo2Icon data-icon="inline-start" />
            Discard all
          </Button>
          <div className="inline-flex overflow-hidden rounded-lg">
            <Button type="submit" disabled={!canCommit} className="rounded-none">
              {amend ? "Amend" : "Commit"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  disabled={!canAmend}
                  aria-label="Commit options"
                  className="rounded-none border-l border-primary-foreground/20 px-1.5"
                >
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  checked={amend}
                  onCheckedChange={(checked) => toggleAmend(checked === true)}
                >
                  Amend last commit
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </form>

      <Dialog open={!!discardTarget} onOpenChange={(open) => !open && setDiscardTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              This restores the selected files to HEAD and deletes untracked files. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (discardTarget) void discard(discardTarget);
                setDiscardTarget(null);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  title,
  count,
  open,
  onOpenChange,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionLabel: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mb-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/70"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
        >
          <ChevronDownIcon
            className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")}
          />
          <span className="text-xs font-medium">{title}</span>
          <span className="tabular-nums text-xs text-muted-foreground">{count}</span>
        </button>
        {onAction ? (
          <Button variant="ghost" size="xs" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
      {open ? <div className="pb-1">{children}</div> : null}
    </section>
  );
}
