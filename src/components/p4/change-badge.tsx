export function ChangeBadge({ id }: { id: string }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded bg-foreground/12 px-1 font-mono text-[10px] leading-none font-medium text-foreground/80 tabular-nums">
      {id === "default" ? "default" : `#${id}`}
    </span>
  );
}
