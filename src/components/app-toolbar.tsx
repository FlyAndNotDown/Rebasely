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
import { useGit } from "@/state/git-context";

export function AppToolbar() {
  const { snapshot, fetchRemote, fetchAllRemotes, pullRemote, pushRemote, applyPatch } = useGit();
  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [forcePushOpen, setForcePushOpen] = useState(false);
  if (!snapshot) return null;

  const ahead = snapshot.repo.ahead ?? 0;
  const behind = snapshot.repo.behind ?? 0;

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-0.5 rounded-[min(var(--radius-md),12px)] border border-foreground/15 bg-secondary px-0.5">
        <SplitAction
          label="Fetch"
          onClick={() => void fetchRemote()}
          menuLabel="Fetch options"
          menu={
            <DropdownMenuContent align="start" className="min-w-36">
              {snapshot.remotes.map((remote) => (
                <DropdownMenuItem
                  key={remote.name}
                  className="font-mono"
                  onClick={() => void fetchRemote(remote.name)}
                >
                  {remote.name}
                </DropdownMenuItem>
              ))}
              {snapshot.remotes.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onClick={() => void fetchAllRemotes()}>All remotes</DropdownMenuItem>
            </DropdownMenuContent>
          }
        >
          <ArrowDownFromLineIcon className="size-4" />
        </SplitAction>
        <ToolbarAction
          label="Pull"
          hint={behind > 0 ? `Pull · ${behind} behind` : "Pull"}
          badge={behind > 0 ? behind : undefined}
          onClick={() => void pullRemote()}
        >
          <ArrowDownToLineIcon className="size-4" />
        </ToolbarAction>
        <SplitAction
          label="Push"
          hint={ahead > 0 ? `Push · ${ahead} ahead` : "Push"}
          badge={ahead > 0 ? ahead : undefined}
          onClick={() => void pushRemote()}
          menuLabel="Push options"
          menu={
            <DropdownMenuContent align="start" className="min-w-36">
              <DropdownMenuItem onClick={() => setForcePushOpen(true)}>
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
        <span className="mx-0.5 h-3.5 w-px bg-foreground/20" />
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
              This overwrites the remote branch with your local history. Anyone else who pushed to
              this branch may need to recover their work.
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
                void pushRemote(true);
              }}
            >
              Force push
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const actionClass =
  "h-6! w-6! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

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
          className={cn(actionClass, badge != null && "w-auto! gap-0.5 px-1", className)}
          aria-label={tip}
          onClick={onClick}
        >
          {children}
          {badge != null ? (
            <span className="min-w-2 text-[10px] leading-none font-semibold tabular-nums">{badge}</span>
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
            className="h-6! w-4! rounded-[6px] px-0 text-foreground/75 hover:bg-background hover:text-foreground aria-expanded:bg-background aria-expanded:text-foreground dark:hover:bg-background dark:aria-expanded:bg-background"
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
