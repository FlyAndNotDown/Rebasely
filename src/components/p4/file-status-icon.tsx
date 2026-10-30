import type { ReactNode } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  FileIcon,
  GitMergeIcon,
  LockIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function FileStatusIcon({ status, className }: { status?: string; className?: string }) {
  const mark = statusMark(status ?? "");
  return (
    <span className={cn("relative inline-flex size-3.5 shrink-0", className)}>
      <FileIcon className={cn("size-3.5", mark?.iconClass ?? "text-muted-foreground")} />
      {mark ? (
        <span className="absolute -right-1 -bottom-1 rounded-full bg-background leading-none">{mark.badge}</span>
      ) : null}
    </span>
  );
}

function statusMark(status: string): { iconClass: string; badge: ReactNode } | null {
  if (status === "stale") {
    return { iconClass: "text-status-warning", badge: <CircleAlertIcon className="size-2.5 text-status-warning" /> };
  }
  if (status === "conflict") {
    return { iconClass: "text-status-warning", badge: <TriangleAlertIcon className="size-2.5 text-status-warning" /> };
  }
  if (status === "other") {
    return { iconClass: "text-destructive", badge: <LockIcon className="size-2.5 text-destructive" /> };
  }
  if (status === "edit") {
    return { iconClass: "text-diff-hunk", badge: <PencilIcon className="size-2.5 text-diff-hunk" /> };
  }
  if (status === "clean") {
    return { iconClass: "text-muted-foreground", badge: <CheckIcon className="size-2.5 text-muted-foreground" /> };
  }
  if (status === "add") {
    return { iconClass: "text-diff-add", badge: <PlusIcon className="size-2.5 text-diff-add" /> };
  }
  if (status === "delete") {
    return { iconClass: "text-diff-del", badge: <MinusIcon className="size-2.5 text-diff-del" /> };
  }
  if (status === "integrate") {
    return { iconClass: "text-diff-hunk", badge: <GitMergeIcon className="size-2.5 text-diff-hunk" /> };
  }
  if (status === "local") {
    return { iconClass: "text-muted-foreground", badge: <CircleHelpIcon className="size-2.5 text-muted-foreground" /> };
  }
  return null;
}
