import { useMemo } from "react";
import { Columns2Icon } from "lucide-react";
import { toast } from "sonner";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { splitRows } from "@/lib/diff-select";
import { textColumns } from "@/lib/diff-text";
import { cn } from "@/lib/utils";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { useGitPick } from "@/state/git-context";
import type { DiffLine, FileDiff } from "@/types/git";

async function copyPath(value: string) {
  if (!value) {
    toast.error("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied path");
  } catch {
    toast.error("Could not copy");
  }
}

export function P4Diff({
  diff,
  loading,
  empty,
  split,
  captions,
  chrome = true,
}: {
  diff: FileDiff | null;
  loading: boolean;
  empty: string;
  split?: boolean;
  captions?: [string, string];
  chrome?: boolean;
}) {
  const { prefs, setDiffOptions } = useGitPick(["prefs", "setDiffOptions"]);
  const contentLines = useMemo(() => diff?.lines.filter((line) => line.kind !== "hunk") ?? [], [diff]);
  const sideBySide = split ?? prefs.diffSplit;
  const frame = chrome ? "absolute inset-0" : "min-h-0 flex-1";
  if (loading && !diff) {
    return (
      <div className={chrome ? "absolute inset-0" : "relative min-h-0 flex-1"}>
        <DiffSkeleton fill />
      </div>
    );
  }
  if (!diff) {
    return (
      <div className={cn("flex items-center justify-center p-6 text-center text-sm text-muted-foreground", frame)}>
        {empty}
      </div>
    );
  }
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", frame)}>
      {chrome ? (
        <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
          <button
            type="button"
            className="min-w-0 truncate text-left font-mono text-sm hover:underline"
            onClick={() => void copyPath(diff.path)}
          >
            {diff.path || "Diff"}
          </button>
          {diff.binary ? null : (
            <HoverTip label="Side by side">
              <Button
                type="button"
                size="icon-xs"
                variant={sideBySide ? "secondary" : "ghost"}
                aria-pressed={sideBySide}
                aria-label="Side by side"
                onClick={() => void setDiffOptions({ split: !sideBySide })}
              >
                <Columns2Icon />
              </Button>
            </HoverTip>
          )}
        </div>
      ) : null}
      {captions && sideBySide && !diff.binary ? (
        <div className="grid shrink-0 grid-cols-2 border-b text-xs text-muted-foreground">
          <div className="px-3 py-1.5">{captions[0]}</div>
          <div className="border-l px-3 py-1.5">{captions[1]}</div>
        </div>
      ) : null}
      {diff.binary ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Binary file
        </div>
      ) : contentLines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {captions ? empty : "No differences against the have revision"}
        </div>
      ) : sideBySide ? (
        <SplitDiff lines={contentLines} />
      ) : (
        <InlineDiff lines={contentLines} />
      )}
      {diff.truncated ? (
        <div className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          Diff truncated
        </div>
      ) : null}
    </div>
  );
}

function InlineDiff({ lines }: { lines: DiffLine[] }) {
  const { viewportRef, start, end, before, after } = useWindowedRows(lines.length, 20);
  const widest = useMemo(() => lines.reduce((width, line) => Math.max(width, textColumns(line.content)), 0), [lines]);
  return (
    <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5 [tab-size:4]">
      <div style={{ minWidth: `calc(4.5rem + ${widest}ch)` }}>
      <div aria-hidden style={{ height: before }} />
      {lines.slice(start, end).map((line, index) => (
        <DiffRow key={start + index} line={line} />
      ))}
      <div aria-hidden style={{ height: after }} />
      </div>
    </div>
  );
}

function SplitDiff({ lines }: { lines: DiffLine[] }) {
  const pairs = useMemo(() => splitRows(lines), [lines]);
  const { viewportRef, start, end, before, after } = useWindowedRows(pairs.length, 20);
  return (
    <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
      <div aria-hidden style={{ height: before }} />
      {pairs.slice(start, end).map((row, index) => {
        if (row.kind === "hunk") return null;
        const left = row.left === null ? undefined : lines[row.left];
        const right = row.right === null ? undefined : lines[row.right];
        return (
          <div key={start + index} className="grid h-5 grid-cols-2">
            <SplitCell line={left} side="left" />
            <SplitCell line={right} side="right" />
          </div>
        );
      })}
      <div aria-hidden style={{ height: after }} />
    </div>
  );
}

function SplitCell({ line, side }: { line: DiffLine | undefined; side: "left" | "right" }) {
  const blank = !line || line.kind === "hunk" || (side === "left" && line.kind === "add") || (side === "right" && line.kind === "delete");
  const lineno = blank || !line ? "" : side === "left" ? line.oldLineno : line.newLineno;
  return (
    <div className={cn("flex min-w-0 border-r border-border/60", !blank && line && lineClass(line.kind))}>
      <span className="w-10 shrink-0 select-none px-2 text-right text-muted-foreground/80 tabular-nums">
        {lineno ?? ""}
      </span>
      <span className="min-w-0 flex-1 truncate px-2" title={blank ? undefined : line.content}>{blank ? " " : line.content || " "}</span>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const mark = line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "hunk" ? "" : " ";
  return (
    <div className={cn("flex h-5 min-w-0", lineClass(line.kind))}>
      <span className="w-10 shrink-0 select-none px-2 text-right text-muted-foreground/80">
        {line.kind === "delete" ? line.oldLineno : line.newLineno}
      </span>
      <span className="w-4 shrink-0 select-none">{mark}</span>
      <span className="min-w-0 flex-1 whitespace-pre px-2">{line.kind === "hunk" ? line.content : line.content || " "}</span>
    </div>
  );
}

function lineClass(kind: string) {
  if (kind === "add") return "bg-diff-add-bg text-diff-add";
  if (kind === "delete") return "bg-diff-del-bg text-diff-del";
  if (kind === "hunk") return "bg-diff-hunk/15 text-diff-hunk";
  return "";
}
