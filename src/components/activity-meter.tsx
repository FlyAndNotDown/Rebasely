import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { gitApi } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useActivities, useGitPick } from "@/state/git-context";
import type { Activity } from "@/types/git";

export function ActivityMeter() {
  const { activeTabId } = useGitPick(["activeTabId"]);
  const activities = useActivities().filter((activity) => activity.tabId === activeTabId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  if (activities.length === 0) return null;

  function cancel(id: string) {
    setCancelling((current) => new Set(current).add(id));
    void gitApi.cancelActivity(id).catch(() => undefined);
  }

  const latest = activities[activities.length - 1];

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setExpandedId(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ml-2 flex h-7 w-40 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-muted"
          aria-label={
            activities.length === 1
              ? latest.label
              : `${activities.length} operations running`
          }
        >
          <ActivityBar activity={latest} />
          {latest.progress != null ? (
            <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {Math.round(latest.progress)}%
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuLabel>
          {activities.length === 1 ? "Running" : `${activities.length} running`}
        </DropdownMenuLabel>
        {activities.map((activity) => {
          const expanded = expandedId === activity.id;
          const stopping = cancelling.has(activity.id);
          return (
            <div key={activity.id} className="flex items-start gap-1 hover:bg-muted/60">
              <button
                type="button"
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
                onClick={() =>
                  setExpandedId((current) => (current === activity.id ? null : activity.id))
                }
              >
                <div className="flex items-center gap-2">
                  <div className={cn("min-w-0 flex-1 text-sm", expanded ? "whitespace-pre-wrap break-words" : "truncate")}>
                    {stopping ? `Cancelling: ${activity.label}` : activity.label}
                  </div>
                  {activity.progress != null ? (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {Math.round(activity.progress)}%
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5">
                  <ActivityBar activity={activity} />
                </div>
                {activity.detail ? (
                  <div
                    className={cn(
                      "mt-1 font-mono text-[11px] text-muted-foreground",
                      expanded ? "whitespace-pre-wrap break-all" : "truncate",
                    )}
                  >
                    {activity.detail}
                  </div>
                ) : null}
              </button>
              {activity.cancellable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="mt-1 mr-1"
                  disabled={stopping}
                  aria-label={`Cancel ${activity.label}`}
                  onClick={() => cancel(activity.id)}
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActivityBar({ activity }: { activity: Activity }) {
  const progress = activity.progress;
  return (
    <span className="relative block h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      {progress != null ? (
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-foreground/75 transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      ) : (
        <span className="activity-indeterminate absolute inset-y-0 left-0 rounded-full bg-foreground/75" />
      )}
    </span>
  );
}
