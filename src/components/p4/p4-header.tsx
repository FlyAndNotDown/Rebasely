import type { ReactNode } from "react";
import { CableIcon, DownloadIcon, FolderSyncIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";

const actionClass =
  "h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

export function P4Header() {
  const { connection, refresh, sync, reconcile, setConnectionOpen } = useP4();
  const client = connection?.client ?? "";

  return (
    <div className="flex min-w-0 items-center gap-2">
      {client ? (
        <span className="max-w-56 truncate font-mono text-sm" title={client}>
          {client}
        </span>
      ) : null}
      <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-input bg-secondary px-0.5">
        <HeaderButton label="Refresh" onClick={() => void refresh()}>
          <RefreshCwIcon />
        </HeaderButton>
        <HeaderButton label="Get latest" onClick={() => void sync()}>
          <DownloadIcon />
        </HeaderButton>
        <HeaderButton label="Reconcile" onClick={() => void reconcile()}>
          <FolderSyncIcon />
        </HeaderButton>
        <span className="h-3.5 w-px self-center bg-foreground/20" />
        <HeaderButton label="Edit connection" onClick={() => setConnectionOpen(true)}>
          <CableIcon />
        </HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
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
          className={cn(actionClass)}
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
