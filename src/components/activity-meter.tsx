import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useActivities } from "@/state/git-context";
import type { Activity } from "@/types/git";

export function ActivityMeter() {
  const activities = useActivities();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (activities.length === 0) return null;

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
          return (
            <button
              key={activity.id}
              type="button"
              className="w-full px-2 py-1.5 text-left hover:bg-muted/60"
              onClick={() =>
                setExpandedId((current) => (current === activity.id ? null : activity.id))
              }
            >
              <div className="flex items-center gap-2">
                <div className={cn("min-w-0 flex-1 text-sm", expanded ? "whitespace-pre-wrap break-words" : "truncate")}>
                  {activity.label}
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
