import { DownloadIcon, FolderSyncIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useP4 } from "@/state/p4-context";

export function P4Header() {
  const { connection, sync, reconcile, refresh } = useP4();
  const where = connection?.stream || connection?.user || "";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="flex min-w-0 items-baseline gap-2 px-1">
        <span className="max-w-40 truncate font-mono text-sm">{connection?.client || "Perforce"}</span>
        {where ? <span className="max-w-36 truncate text-xs text-muted-foreground">{where}</span> : null}
        {connection?.port ? (
          <span className="max-w-36 truncate font-mono text-[11px] text-muted-foreground">{connection.port}</span>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Get latest" onClick={() => void sync()}>
            <DownloadIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Get latest</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Reconcile" onClick={() => void reconcile()}>
            <FolderSyncIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reconcile</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void refresh()}>
            <RefreshCwIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh</TooltipContent>
      </Tooltip>
    </div>
  );
}
