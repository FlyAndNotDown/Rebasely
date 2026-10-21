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
    return { iconClass: "text-yellow-200", badge: <CircleAlertIcon className="size-2.5 text-yellow-200" /> };
  }
  if (status === "conflict") {
    return { iconClass: "text-orange-300", badge: <TriangleAlertIcon className="size-2.5 text-orange-300" /> };
  }
  if (status === "other") {
    return { iconClass: "text-red-300", badge: <LockIcon className="size-2.5 text-red-300" /> };
  }
  if (status === "edit") {
    return { iconClass: "text-sky-300", badge: <PencilIcon className="size-2.5 text-sky-300" /> };
  }
  if (status === "clean") {
    return { iconClass: "text-muted-foreground", badge: <CheckIcon className="size-2.5 text-zinc-400" /> };
  }
  if (status === "add") {
    return { iconClass: "text-green-300", badge: <PlusIcon className="size-2.5 text-green-300" /> };
  }
  if (status === "delete") {
    return { iconClass: "text-red-300", badge: <MinusIcon className="size-2.5 text-red-300" /> };
  }
  if (status === "integrate") {
    return { iconClass: "text-violet-300", badge: <GitMergeIcon className="size-2.5 text-violet-300" /> };
  }
  if (status === "local") {
    return { iconClass: "text-muted-foreground", badge: <CircleHelpIcon className="size-2.5 text-muted-foreground" /> };
  }
  return null;
}
