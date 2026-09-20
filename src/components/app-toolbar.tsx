import { useState, type ReactNode } from "react";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, DownloadIcon, Settings2Icon } from "lucide-react";
import { RepoSettingsDialog } from "@/components/repo-settings-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGit } from "@/state/git-context";

export function AppToolbar() {
  const { snapshot, fetchRemote, pullRemote, pushRemote } = useGit();
  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  if (!snapshot) return null;

  const ahead = snapshot.repo.ahead ?? 0;
  const behind = snapshot.repo.behind ?? 0;

  return (
    <>
      <div className="flex shrink-0 items-center rounded-md border bg-muted/40 p-0.5">
        <ToolbarIcon label="Fetch" onClick={() => void fetchRemote()}>
          <DownloadIcon />
        </ToolbarIcon>
        <ToolbarIcon
          label={behind > 0 ? `Pull · ${behind} behind` : "Pull"}
          badge={behind > 0 ? behind : undefined}
          onClick={() => void pullRemote()}
        >
          <ArrowDownToLineIcon />
        </ToolbarIcon>
        <ToolbarIcon
          label={ahead > 0 ? `Push · ${ahead} ahead` : "Push"}
          badge={ahead > 0 ? ahead : undefined}
          onClick={() => void pushRemote()}
        >
          <ArrowUpFromLineIcon />
        </ToolbarIcon>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <ToolbarIcon label="Repository settings" onClick={() => setRepoSettingsOpen(true)}>
          <Settings2Icon />
        </ToolbarIcon>
      </div>
      <RepoSettingsDialog open={repoSettingsOpen} onOpenChange={setRepoSettingsOpen} />
    </>
  );
}

function ToolbarIcon({
  label,
  badge,
  onClick,
  children,
}: {
  label: string;
  badge?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="relative text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={onClick}
        >
          {children}
          {badge != null ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-3 rounded-full bg-foreground px-0.5 text-center text-[9px] leading-3 text-background">
              {badge}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
