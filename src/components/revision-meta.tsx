import { AuthorAvatar } from "@/components/author-avatar";
import { HoverTip } from "@/components/ui/tooltip";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function RevisionDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-[9px] shrink-0 rounded-full border-[1.5px] border-muted-foreground/80", className)}
    />
  );
}

export function AuthorName({
  name,
  email = "",
  className,
}: {
  name: string;
  email?: string;
  className?: string;
}) {
  if (!name) return null;
  return (
    <span className={cn("flex w-28 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <AuthorAvatar name={name} email={email} className="size-4" />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

export function ExactTime({ time, className }: { time: number; className?: string }) {
  if (!time) return null;
  return (
    <HoverTip label={formatExactTime(time)}>
      <span
        className={cn(
          "w-[7.25rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground",
          className,
        )}
      >
        {formatAbsoluteTime(time)}
      </span>
    </HoverTip>
  );
}
