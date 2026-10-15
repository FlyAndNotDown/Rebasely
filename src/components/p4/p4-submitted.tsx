import { useEffect, useRef, useState } from "react";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { formatRelativeTime } from "@/lib/format";
import { changeSummary, depotBase, p4ActionClass, p4ActionLetter } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";

export function P4Submitted() {
  const p4 = useP4();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const changes = p4.submitted.filter((change) => {
    if (!needle) return true;
    return (
      change.id.includes(needle) ||
      change.user.toLowerCase().includes(needle) ||
      change.description.toLowerCase().includes(needle)
    );
  });
  const detail = p4.submittedDetail;
  const file =
    picked && detail?.files.some((item) => item.depotPath === picked)
      ? picked
      : (detail?.files[0]?.depotPath ?? null);
  const diff = p4.submittedDiffs.find((item) => item.path === file) ?? null;
  const loaded = useRef(false);
  const connection = p4.connection;
  const loadSubmitted = p4.loadSubmitted;

  useEffect(() => {
    if (!connection || loaded.current) return;
    loaded.current = true;
    void loadSubmitted(false);
  }, [connection, loadSubmitted]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-submitted-list" defaultSize="32%" minSize="22%" maxSize="48%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b p-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter changelists"
              className="h-8"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {changes.length === 0 && !p4.submittedLoading ? (
              <p className="p-4 text-sm text-muted-foreground">No submitted changelists.</p>
            ) : (
              changes.map((change) => {
                const active = change.id === p4.selectedSubmitted;
                return (
                  <button
                    key={change.id}
                    type="button"
                    className={cn(
                      "block w-full border-b px-3 py-2 text-left",
                      active ? "bg-muted" : "hover:bg-muted/50",
                    )}
                    onClick={() => void p4.selectSubmitted(change.id)}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-sm">#{change.id}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {change.time ? formatRelativeTime(change.time) : ""}
                      </span>
                    </div>
                    <div className="truncate text-xs">{changeSummary(change.description) || "No description"}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{change.user}</div>
                  </button>
                );
              })
            )}
          </div>
          {p4.submittedHasMore ? (
            <div className="shrink-0 border-t p-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full"
                disabled={p4.submittedLoading}
                onClick={() => void p4.loadSubmitted(p4.submitted.length > 0)}
              >
                {p4.submittedLoading ? "Loading" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-submitted-main" defaultSize="68%" minSize="40%">
        <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0">
          <ResizablePanel id="p4-submitted-files" defaultSize="32%" minSize="16%">
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b px-3 py-2">
                <div className="truncate text-sm">
                  {p4.submittedDetail
                    ? changeSummary(p4.submittedDetail.description) || `Change ${p4.submittedDetail.id}`
                    : "Submitted"}
                </div>
                {p4.submittedDetail?.description && changeSummary(p4.submittedDetail.description) !== p4.submittedDetail.description.trim() ? (
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {p4.submittedDetail.description}
                  </p>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
                {p4.submittedDetail?.files.map((item) => (
                  <button
                    key={item.depotPath}
                    type="button"
                    title={item.action}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
                      file === item.depotPath && "bg-muted",
                    )}
                    onClick={() => setPicked(item.depotPath)}
                  >
                    <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-medium", p4ActionClass(item.action))}>
                      {p4ActionLetter(item.action)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={item.depotPath}>
                      {depotBase(item.depotPath)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="p4-submitted-diff" defaultSize="68%" minSize="24%">
            <P4Diff
              diff={diff}
              loading={p4.submittedLoading && !p4.submittedDetail}
              empty={p4.selectedSubmitted ? "Select a file to see its diff" : "Select a changelist"}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
