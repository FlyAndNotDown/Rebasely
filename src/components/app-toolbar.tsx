import { useState, type ReactNode } from "react";
import {
  ArrowDownFromLineIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  FileInputIcon,
  Settings2Icon,
} from "lucide-react";
import { RepoSettingsDialog } from "@/components/repo-settings-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { defaultFetchRemote, primaryRemote, useGit } from "@/state/git-context";

export function AppToolbar() {
  const {
    snapshot,
    fetchRemote,
    fetchAllRemotes,
    pullRemote,
    pushRemote,
    publishPrompt,
    dismissPublish,
    confirmPublish,
    applyPatch,
  } = useGit();
  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [forcePushOpen, setForcePushOpen] = useState(false);
  if (!snapshot) return null;

  const ahead = snapshot.repo.ahead ?? 0;
  const behind = snapshot.repo.behind ?? 0;
  const primary = primaryRemote(snapshot);
  const fetchTarget = defaultFetchRemote(snapshot) ?? primary;

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-input bg-secondary px-0.5">
        <SplitAction
          label="Fetch"
          hint={fetchTarget ? `Fetch from ${fetchTarget}` : "Fetch"}
          onClick={() => void fetchRemote()}
          menuLabel="Fetch options"
          menu={
            <DropdownMenuContent align="start" className="min-w-max">
              {snapshot.remotes.map((remote) => (
                <DropdownMenuItem
                  key={remote.name}
                  onClick={() => void fetchRemote(remote.name)}
                >
                  Fetch from <span className="font-mono">'{remote.name}'</span>
                </DropdownMenuItem>
              ))}
              {snapshot.remotes.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onClick={() => void fetchAllRemotes()}>
                Fetch all remotes
              </DropdownMenuItem>
            </DropdownMenuContent>
          }
        >
          <ArrowDownFromLineIcon className="size-4" />
        </SplitAction>
        <SplitAction
          label="Pull"
          hint={
            primary
              ? behind > 0
                ? `Pull from ${primary} · ${behind} behind`
                : `Pull from ${primary}`
              : "Pull"
          }
          badge={behind > 0 ? behind : undefined}
          onClick={() => void pullRemote()}
          menuLabel="Pull options"
          menu={
            <DropdownMenuContent align="start" className="min-w-max">
              {snapshot.remotes.map((remote) => (
                <DropdownMenuItem
                  key={remote.name}
                  onClick={() => void pullRemote(remote.name)}
                >
                  Pull from <span className="font-mono">'{remote.name}'</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          }
        >
          <ArrowDownToLineIcon className="size-4" />
        </SplitAction>
        <SplitAction
          label="Push"
          hint={
            primary
              ? ahead > 0
                ? `Push to ${primary} · ${ahead} ahead`
                : `Push to ${primary}`
              : "Push"
          }
          badge={ahead > 0 ? ahead : undefined}
          onClick={() => void pushRemote()}
          menuLabel="Push options"
          menu={
            <DropdownMenuContent align="start" className="min-w-max">
              {snapshot.remotes.map((remote) => (
                <DropdownMenuItem
                  key={remote.name}
                  onClick={() => void pushRemote({ remote: remote.name })}
                >
                  Push to <span className="font-mono">'{remote.name}'</span>
                </DropdownMenuItem>
              ))}
              {snapshot.remotes.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                onClick={() => {
                  if (!snapshot.repo.upstream) {
                    void pushRemote();
                    return;
                  }
                  setForcePushOpen(true);
                }}
              >
                Force push
              </DropdownMenuItem>
            </DropdownMenuContent>
          }
        >
          <ArrowUpFromLineIcon className="size-4" />
        </SplitAction>
        <ToolbarAction label="Apply patch" onClick={() => void applyPatch()}>
          <FileInputIcon className="size-4" />
        </ToolbarAction>
        <span className="h-3.5 w-px self-center bg-foreground/20" />
        <ToolbarAction label="Repository settings" onClick={() => setRepoSettingsOpen(true)}>
          <Settings2Icon className="size-4" />
        </ToolbarAction>
      </div>
      <RepoSettingsDialog open={repoSettingsOpen} onOpenChange={setRepoSettingsOpen} />
      <Dialog open={forcePushOpen} onOpenChange={setForcePushOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force push?</DialogTitle>
            <DialogDescription>
              This overwrites{" "}
              <span className="font-mono">
                {primary && snapshot.repo.currentBranch
                  ? `${primary}/${snapshot.repo.currentBranch}`
                  : "the remote branch"}
              </span>{" "}
              with your local history. Anyone else who pushed to this branch may need to recover
              their work.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForcePushOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setForcePushOpen(false);
                void pushRemote({ force: true });
              }}
            >
              Force push
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!publishPrompt}
        onOpenChange={(open) => {
          if (!open) dismissPublish();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish branch?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{publishPrompt?.branch}</span> does not track a remote
              branch. Publish it to <span className="font-mono">{publishPrompt?.remote}</span> and
              set that as the upstream?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissPublish}>
              Cancel
            </Button>
            <Button onClick={() => void confirmPublish()}>Publish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const actionClass =
  "h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

function ToolbarAction({
  label,
  hint,
  badge,
  onClick,
  className,
  children,
}: {
  label: string;
  hint?: string;
  badge?: number;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  const tip = hint ?? label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(actionClass, "relative", className)}
          aria-label={tip}
          onClick={onClick}
        >
          {children}
          {badge != null ? (
            <span className="pointer-events-none absolute top-0.5 right-0.5 z-10 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background tabular-nums ring-2 ring-secondary">
              {badge}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

function SplitAction({
  label,
  hint,
  badge,
  menuLabel,
  onClick,
  menu,
  children,
}: {
  label: string;
  hint?: string;
  badge?: number;
  menuLabel: string;
  onClick: () => void;
  menu: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-px">
      <ToolbarAction label={label} hint={hint} badge={badge} onClick={onClick}>
        {children}
      </ToolbarAction>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-[calc(1.75rem-2px)]! w-4! rounded-[6px] px-0 text-foreground/75 hover:bg-background hover:text-foreground aria-expanded:bg-background aria-expanded:text-foreground dark:hover:bg-background dark:aria-expanded:bg-background"
            aria-label={menuLabel}
          >
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    </div>
  );
}
