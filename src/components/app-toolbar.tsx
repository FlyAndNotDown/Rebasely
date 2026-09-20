import type { ReactNode } from "react";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGit } from "@/state/git-context";

export function AppToolbar() {
  const { snapshot, fetchRemote, pullRemote, pushRemote } = useGit();
  if (!snapshot) return null;

  const ahead = snapshot.repo.ahead ?? 0;
  const behind = snapshot.repo.behind ?? 0;

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
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
    </div>
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
          size="icon-sm"
          className="relative"
          aria-label={label}
          onClick={onClick}
        >
          {children}
          {badge != null ? (
            <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-muted px-0.5 text-center text-[9px] leading-3.5 text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
