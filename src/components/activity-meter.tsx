import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGit } from "@/state/git-context";

export function ActivityMeter() {
  const { activities } = useGit();
  if (activities.length === 0) return null;

  const latest = activities[activities.length - 1];

  return (
    <DropdownMenu>
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
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>
          {activities.length === 1 ? "Running" : `${activities.length} running`}
        </DropdownMenuLabel>
        {activities.map((activity) => (
          <div key={activity.id} className="px-2 py-1.5">
            <div className="truncate text-sm">{activity.label}</div>
            {activity.detail ? (
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {activity.detail}
              </div>
            ) : null}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
