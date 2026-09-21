import { GitBranchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function AppMark({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-[22%] bg-zinc-900 text-zinc-100",
        className,
      )}
    >
      <GitBranchIcon className={iconClassName} />
    </div>
  );
}
