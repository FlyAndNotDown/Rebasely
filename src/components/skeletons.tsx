import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const diffWidths = [
  "w-4/5",
  "w-2/3",
  "w-1/2",
  "w-3/4",
  "w-2/5",
  "w-11/12",
  "w-3/5",
  "w-1/3",
  "w-2/3",
  "w-1/2",
  "w-3/4",
  "w-2/5",
];

export function HistorySkeleton({
  rows = 12,
  label = "Loading history",
  fill = false,
}: {
  rows?: number;
  label?: string;
  /** Cover the whole list, instead of a short block at the top. */
  fill?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={fill ? "absolute inset-0 overflow-hidden pe-4" : "w-full py-1"}
    >
      {Array.from({ length: fill ? 80 : rows }, (_, index) => (
        <div key={index} className="flex h-8 w-full items-center gap-2 px-2">
          <Skeleton className="h-3 w-4 shrink-0 rounded-full" />
          <Skeleton className="h-3 min-w-0 flex-1" />
          <span className="flex w-28 shrink-0 items-center gap-1.5">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-3 w-14" />
          </span>
          <Skeleton className="h-3 w-[7.25rem] shrink-0" />
        </div>
      ))}
    </div>
  );
}

const branchRowWidths = ["w-3/5", "w-2/5", "w-4/5", "w-1/2", "w-2/3"];

/** Placeholder for the history branch column until branches, tags, and worktrees arrive together. */
export function BranchSidebarSkeleton() {
  const sections = [5, 4, 3, 2, 5, 4, 3];
  return (
    <div role="status" aria-label="Loading branches" className="absolute inset-0 overflow-hidden py-1">
      {sections.map((rows, section) => (
        <div key={section}>
          <div className="flex h-7 items-center px-2">
            <Skeleton className="h-2.5 w-14" />
          </div>
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex h-7 items-center gap-2 pr-2 pl-7">
              <Skeleton className="size-3.5 shrink-0 rounded-sm" />
              <Skeleton className={cn("h-3", branchRowWidths[(section + index) % branchRowWidths.length])} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const treeWidths = ["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5", "w-1/4"];

export function FileTreeSkeleton({
  rows = 14,
  label = "Searching files",
  fill = false,
}: {
  rows?: number;
  label?: string;
  /** Cover the whole tree pane, instead of a short block at the top. */
  fill?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={fill ? "absolute inset-0 overflow-hidden py-1" : "py-1"}
    >
      {Array.from({ length: fill ? 60 : rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 pr-2" style={{ paddingLeft: 8 + (index % 4) * 12 }}>
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3", treeWidths[index % treeWidths.length])} />
        </div>
      ))}
    </div>
  );
}

export function FileRowsSkeleton({
  rows = 8,
  label = "Loading files",
  fill = false,
}: {
  rows?: number;
  label?: string;
  /** Cover the whole file list, instead of a short block at the top. */
  fill?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={fill ? "absolute inset-0 overflow-hidden px-1 py-1" : "px-1 py-1"}
    >
      {Array.from({ length: fill ? 80 : rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 px-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3", index % 2 === 0 ? "w-2/5" : "w-3/5")} />
        </div>
      ))}
    </div>
  );
}

export function CommitFilesSkeleton() {
  return (
    <div role="status" aria-label="Loading files" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 py-2">
        <Skeleton className="h-4 w-2/3" />
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-14" />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 border-t">
        <div className="absolute inset-0 overflow-hidden px-3 py-2">
          {Array.from({ length: 80 }, (_, index) => (
            <div key={index} className="flex h-7 items-center gap-2">
              <Skeleton className="h-3 w-3 shrink-0" />
              <Skeleton className={cn("h-3", index % 2 === 0 ? "w-3/5" : "w-2/5")} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DiffSkeleton({
  label = "Loading diff",
  status = true,
  fill = false,
}: {
  label?: string;
  status?: boolean;
  /** Cover the whole pane instead of a short block at the top. */
  fill?: boolean;
}) {
  const widths = fill ? Array.from({ length: 80 }, (_, index) => diffWidths[index % diffWidths.length]) : diffWidths;
  const rows = widths.map((width, index) => (
    <div
      key={index}
      className="grid h-5 w-full grid-cols-[3rem_1.25rem_minmax(0,1fr)] items-center px-2"
    >
      <Skeleton className="ml-auto h-2.5 w-4" />
      <span />
      <Skeleton className={cn("h-2.5", width)} />
    </div>
  ));
  if (fill) {
    return (
      <div
        role={status ? "status" : undefined}
        aria-label={status ? label : undefined}
        className="absolute inset-0 overflow-hidden py-2"
      >
        {rows}
      </div>
    );
  }
  return (
    <div role={status ? "status" : undefined} aria-label={status ? label : undefined} className="py-2">
      {rows}
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div role="status" aria-label="Opening repository" className="flex h-full min-h-0">
      <div className="flex w-[36%] min-w-56 flex-col border-r">
        <div className="min-h-0 flex-1 space-y-2 px-3 py-3">
          <Skeleton className="h-3 w-16" />
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className={cn("h-4", index % 3 === 0 ? "w-4/5" : "w-full")} />
          ))}
          <Skeleton className="mt-4 h-3 w-14" />
          <Skeleton className="h-4 w-3/5" />
        </div>
        <div className="space-y-2 border-t p-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center border-b px-3">
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="relative min-h-0 flex-1">
          <DiffSkeleton status={false} fill />
        </div>
      </div>
    </div>
  );
}
