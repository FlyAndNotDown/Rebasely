import type { LucideIcon } from "lucide-react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CloudIcon,
  FolderTreeIcon,
  GitMergeIcon,
  HardDriveIcon,
  HashIcon,
  HistoryIcon,
  InfoIcon,
  LockIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  TriangleAlertIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";

export function fileStatusText(depotPath: string, detail: string, action = "") {
  const body = detail || action;
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (depotPath.startsWith("//") && !lines.includes(depotPath)) lines.unshift(depotPath);
  return lines.join("\n");
}

export function FileStatusTip({ text }: { text: string }) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <span className="flex flex-col gap-1 py-0.5">
      {lines.map((line, index) => {
        const Icon = iconFor(line);
        const depot = line.startsWith("//");
        return (
          <span key={`${index}:${line}`} className="flex items-start gap-1.5">
            <Icon className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden />
            <span className={depot ? "min-w-0 font-mono break-all" : "min-w-0"}>{line}</span>
          </span>
        );
      })}
    </span>
  );
}

function iconFor(line: string): LucideIcon {
  if (line.startsWith("//")) return FolderTreeIcon;
  if (line.startsWith("Changelist ") || line.startsWith("Your changelist ")) return HashIcon;
  if (line.startsWith("Have revision ")) return HardDriveIcon;
  if (line.startsWith("Head revision ")) return CloudIcon;
  if (line.startsWith("Revision ")) return HistoryIcon;
  if (line === "Locked by another user" || line.startsWith("Locked by ")) return LockIcon;
  if (line === "Opened by another user" || line.startsWith("Opened by ")) return UserIcon;
  if (line.includes("more user")) return UsersIcon;
  if (line === "Checked out for edit") return PencilIcon;
  if (line === "Marked for add") return PlusIcon;
  if (line === "Marked for delete") return MinusIcon;
  if (line === "Opened for integrate") return GitMergeIcon;
  if (line === "Needs resolve") return TriangleAlertIcon;
  if (line === "Not latest" || line === "Not synced") return CircleAlertIcon;
  if (line === "Up to date") return CircleCheckIcon;
  if (line === "Not in the depot") return CircleHelpIcon;
  return InfoIcon;
}
