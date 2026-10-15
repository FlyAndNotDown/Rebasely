import { useEffect, useRef, useState, type ReactNode } from "react";
import { DownloadIcon, FilePenIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { FileTree, type FileTreeEntry } from "@/components/file-tree";
import { ChangeBadge } from "@/components/p4/change-badge";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { P4Diff } from "@/components/p4/p4-diff";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { changeSummary, relativeToRoot } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { FileDiff } from "@/types/git";
import type { P4DirEntry, P4Revision } from "@/types/p4";

export function P4Files() {
  const p4 = useP4();
  const root = p4.connection?.root ?? "";
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<P4Revision[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [revisionDiff, setRevisionDiff] = useState<FileDiff | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const request = useRef(0);
  const diffRequest = useRef(0);

  function choose(path: string) {
    if (path === selected && history) return;
    ++diffRequest.current;
    setSelected(path);
    setHistory(null);
    setSelectedRev(null);
    setRevisionDiff(null);
    const token = ++request.current;
    setHistoryLoading(true);
    void p4
      .filelog(path)
      .then(async (revisions) => {
        if (request.current !== token) return;
        setHistory(revisions);
        const first = revisions[0];
        if (!first?.rev) return;
        const diffToken = ++diffRequest.current;
        setSelectedRev(first.rev);
        setRevisionLoading(true);
        try {
          const diff = await p4.revisionDiff(path, first.rev);
          if (request.current === token && diffRequest.current === diffToken) setRevisionDiff(diff);
        } finally {
          if (diffRequest.current === diffToken) setRevisionLoading(false);
        }
      })
      .catch((caught) => {
        if (request.current !== token) return;
        setHistory([]);
        const message = errorMessage(caught);
        if (message && message !== "Login cancelled") toast.error(message);
      })
      .finally(() => {
        if (request.current === token) setHistoryLoading(false);
      });
  }

  async function showRevision(path: string, rev: string) {
    const diffToken = ++diffRequest.current;
    setSelectedRev(rev);
    setRevisionLoading(true);
    try {
      const diff = await p4.revisionDiff(path, rev);
      if (diffRequest.current === diffToken) setRevisionDiff(diff);
    } catch (caught) {
      if (diffRequest.current !== diffToken) return;
      const message = errorMessage(caught);
      if (message && message !== "Login cancelled") toast.error(message);
    } finally {
      if (diffRequest.current === diffToken) setRevisionLoading(false);
    }
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-tree" defaultSize="28%" minSize="18%" maxSize="46%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">Workspace</div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {root ? (
              <WorkspaceTree
                key={root}
                selected={selected}
                onSelect={choose}
                menu={(path) => (
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onClick={() => void p4.sync([path])}>
                      <DownloadIcon />
                      Get latest
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => void p4.fileAction("edit", [path])}>
                      <FilePenIcon />
                      Check out
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => void p4.fileAction("add", [path])}>
                      <PlusIcon />
                      Mark for add
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => void p4.fileAction("delete", [path])}>
                      <Trash2Icon />
                      Mark for delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                )}
              />
            ) : null}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-file-main" defaultSize="72%" minSize="40%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-3">
            <HoverTip label={selected ? relativeToRoot(root, selected) || selected : ""}>
              <div className="min-w-0 flex-1 truncate font-mono text-xs">
                {selected ? relativeToRoot(root, selected) || selected : "Select a file"}
              </div>
            </HoverTip>
          </div>
          {selected ? (
            <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0 flex-1">
              <ResizablePanel id="p4-file-history" defaultSize="34%" minSize="16%">
                <div className="h-full overflow-auto px-1 py-1">
                  {historyLoading && !history ? (
                    <p className="p-3 text-xs text-muted-foreground">Loading history</p>
                  ) : history && history.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground">No revisions.</p>
                  ) : (
                    history?.map((revision) => (
                      <button
                        key={`${revision.rev}:${revision.change}`}
                        type="button"
                        className={cn(
                          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted/70",
                          selectedRev === revision.rev && "bg-muted",
                        )}
                        onClick={() => void showRevision(selected, revision.rev)}
                      >
                        <ChangeBadge id={revision.rev} />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {changeSummary(revision.description) || "No description"}
                        </span>
                        <span className="flex w-36 shrink-0 items-center gap-1.5 text-[11px]">
                          <AuthorAvatar name={revision.user} email="" className="size-4" />
                          <span className="truncate font-medium text-foreground">{revision.user}</span>
                        </span>
                        {revision.time ? (
                          <HoverTip label={formatExactTime(revision.time)}>
                            <span className="w-[7.25rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                              {formatAbsoluteTime(revision.time)}
                            </span>
                          </HoverTip>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="p4-file-diff" defaultSize="66%" minSize="24%">
                <P4Diff
                  diff={revisionDiff}
                  loading={revisionLoading || (historyLoading && !revisionDiff)}
                  empty="No revision to show"
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Open a file to see its history.
            </div>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function WorkspaceTree({
  selected,
  onSelect,
  menu,
}: {
  selected: string | null;
  onSelect: (path: string) => void;
  menu: (path: string) => ReactNode;
}) {
  const { connection, listDir } = useP4();
  const root = connection?.root ?? "";
  const [entries, setEntries] = useState<Record<string, FileTreeEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void listDir("")
      .then((next) => {
        if (live) setEntries({ "": next.map(presentFile) });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [listDir]);

  async function toggle(path: string) {
    if (open.has(path)) {
      setOpen((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    if (!entries[path]) {
      try {
        const next = await listDir(relativeToRoot(root, path));
        setEntries((current) => ({ ...current, [path]: next.map(presentFile) }));
      } catch {
        return;
      }
    }
    setOpen((current) => new Set(current).add(path));
  }

  if (failed) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Could not read the workspace folder.</p>;
  }
  return (
    <FileTree
      dir=""
      depth={0}
      entries={entries}
      open={open}
      selected={selected}
      onToggle={(path) => void toggle(path)}
      onOpenFile={onSelect}
      menu={(entry) => menu(entry.path)}
    />
  );
}

function presentFile(entry: P4DirEntry): FileTreeEntry {
  return {
    path: entry.path,
    name: entry.name,
    dir: entry.dir,
    icon: entry.dir ? undefined : <FileStatusIcon status={entry.status} />,
    iconTitle: entry.detail || undefined,
  };
}
