import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function ActivityMeter() {
  const { activities } = useGit();
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
          className="flex h-7 w-[4.5rem] shrink-0 flex-col justify-center rounded-md px-1.5 hover:bg-muted"
          aria-label={
            activities.length === 1
              ? latest.label
              : `${activities.length} operations running`
          }
        >
          <span className="relative block h-1 w-full overflow-hidden rounded-full bg-muted">
            <span className="activity-indeterminate absolute inset-y-0 left-0 rounded-full bg-foreground/75" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
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
              <div className={cn("text-sm", expanded ? "whitespace-pre-wrap break-words" : "truncate")}>
                {activity.label}
              </div>
              {activity.detail ? (
                <div
                  className={cn(
                    "font-mono text-[11px] text-muted-foreground",
                    expanded ? "mt-0.5 whitespace-pre-wrap break-all" : "truncate",
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
