import { useMemo } from "react";
import { Columns2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { splitRows } from "@/lib/diff-select";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { DiffLine, FileDiff } from "@/types/git";

export function P4Diff({
  diff,
  loading,
  empty,
}: {
  diff: FileDiff | null;
  loading: boolean;
  empty: string;
}) {
  const { prefs, setDiffOptions } = useGitPick(["prefs", "setDiffOptions"]);
  if (loading && !diff) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading diff
      </div>
    );
  }
  if (!diff) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0 truncate font-mono text-sm" title={diff.path}>
          {diff.path || "Diff"}
        </div>
        {diff.binary ? null : (
          <Button
            type="button"
            size="icon-xs"
            variant={prefs.diffSplit ? "secondary" : "ghost"}
            aria-pressed={prefs.diffSplit}
            aria-label="Side by side"
            title="Side by side"
            onClick={() => void setDiffOptions({ split: !prefs.diffSplit })}
          >
            <Columns2Icon />
          </Button>
        )}
      </div>
      {diff.binary ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Binary file
        </div>
      ) : diff.lines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          No differences against the have revision
        </div>
      ) : prefs.diffSplit ? (
        <SplitDiff lines={diff.lines} />
      ) : (
        <InlineDiff lines={diff.lines} />
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
  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
      {lines.map((line, index) => (
        <DiffRow key={index} line={line} />
      ))}
    </div>
  );
}

function SplitDiff({ lines }: { lines: DiffLine[] }) {
  const pairs = useMemo(() => splitRows(lines), [lines]);
  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
      {pairs.map((row, index) => {
        if (row.kind === "hunk") {
          return (
            <div key={index} className="bg-diff-hunk/15 px-3 text-diff-hunk">
              {lines[row.index]?.content}
            </div>
          );
        }
        const left = row.left === null ? undefined : lines[row.left];
        const right = row.right === null ? undefined : lines[row.right];
        return (
          <div key={index} className="grid grid-cols-2">
            <SplitCell line={left} side="left" />
            <SplitCell line={right} side="right" />
          </div>
        );
      })}
    </div>
  );
}

function SplitCell({ line, side }: { line: DiffLine | undefined; side: "left" | "right" }) {
  if (!line || line.kind === "hunk" || (side === "left" && line.kind === "add") || (side === "right" && line.kind === "delete")) {
    return <div className="border-r border-border/60 px-2 text-transparent">.</div>;
  }
  return (
    <div className={cn("truncate border-r border-border/60 px-2", lineClass(line.kind))}>
      {line.content || " "}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const mark = line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "hunk" ? "" : " ";
  return (
    <div className={cn("flex min-w-0", lineClass(line.kind))}>
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
