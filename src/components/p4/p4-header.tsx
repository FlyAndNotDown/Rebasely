import type { ReactNode } from "react";
import { CableIcon, DownloadIcon, FolderPenIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";

const actionClass =
  "h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

export function P4Header() {
  const { connection, busy, refresh, sync, setConnectionOpen, setWorkspaceOpen } = useP4();
  const client = connection?.client ?? "";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {client ? (
        <HoverTip label={client}>
          <Button variant="outline" size="sm" asChild className="max-w-44 shrink-0 cursor-default font-mono">
            <span>
              <span className="truncate">{client}</span>
            </span>
          </Button>
        </HoverTip>
      ) : null}
      <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-input bg-secondary px-0.5">
        <HeaderButton label="Refresh" disabled={busy} onClick={() => void refresh()}>
          <RefreshCwIcon className="size-4" />
        </HeaderButton>
        <HeaderButton label="Get latest" disabled={busy} onClick={() => void sync()}>
          <DownloadIcon className="size-4" />
        </HeaderButton>
        <span className="h-3.5 w-px self-center bg-foreground/20" />
        <HeaderButton label="Edit connection" disabled={busy} onClick={() => setConnectionOpen(true)}>
          <CableIcon className="size-4" />
        </HeaderButton>
        <HeaderButton label="Edit workspace" disabled={busy} onClick={() => setWorkspaceOpen(true)}>
          <FolderPenIcon className="size-4" />
        </HeaderButton>
      </div>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
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
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
