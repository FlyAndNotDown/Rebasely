import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DownloadIcon, FilePenIcon, HistoryIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { FileTree, FileTreeFilter, FilteredFileTree, type FileTreeEntry } from "@/components/file-tree";
import { ChangeBadge } from "@/components/p4/change-badge";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { FileStatusTip } from "@/components/p4/file-status-tip";
import { P4GetRevisionDialog } from "@/components/p4/p4-get-revision-dialog";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { HoverTip } from "@/components/ui/tooltip";
import { FileTreeSkeleton } from "@/components/skeletons";
import { errorMessage } from "@/lib/git";
import { joinRoot, type SearchNode } from "@/lib/file-search";
import { changeSummary, p4Api, relativeToRoot } from "@/lib/p4";
import { useFileQuery } from "@/lib/use-file-query";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { FileDiff } from "@/types/git";
import type { P4DirEntry, P4Revision } from "@/types/p4";

export function P4Files() {
  const p4 = useP4();
  const root = p4.connection?.root ?? "";
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"workspace" | "depot">("workspace");
  const connection = p4.connection;
  const searchFiles = useCallback(
    async (needle: string) => {
      if (!connection) return { hits: [], truncated: false, scope: "" };
      try {
        return mode === "depot"
          ? await p4Api.searchDepot(connection, needle)
          : await p4Api.searchFiles(connection, needle);
      } catch (caught) {
        const message = errorMessage(caught);
        if (message && message !== "Login cancelled") toast.error(message);
        throw caught;
      }
    },
    [connection, mode],
  );
  const fileQuery = useFileQuery(`${mode}:${root}`, query, searchFiles, mode === "depot" ? 450 : 200);
  useEffect(() => {
    if (mode === "depot" && query.trim()) return;
    void p4Api.cancelDepotSearch();
  }, [mode, query]);
  const searchNodes = useMemo<SearchNode[]>(() => {
    if (!fileQuery.result) return [];
    return fileQuery.result.hits
      .map((hit) => ({
        relative: mode === "depot" ? hit.path.replace(/^\/+/, "") : relativeToRoot(root, hit.path),
        dir: hit.dir,
        status: hit.status,
        detail: hit.detail,
      }))
      .filter((node) => node.relative);
  }, [fileQuery.result, mode, root]);
  const [revisionPath, setRevisionPath] = useState<string | null>(null);
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

  function fileMenu(entry: FileTreeEntry) {
    const path = p4TreeTarget(entry.path, entry.dir);
    return (
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => void p4.sync([path])}>
          <DownloadIcon />
          Get latest
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setRevisionPath(path)}>
          <HistoryIcon />
          Get revision
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
    );
  }

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-tree" defaultSize="28%" minSize="18%" maxSize="46%">
        <div className="flex h-full min-h-0 flex-col">
          <FileTreeFilter
            title={mode === "depot" ? "Depot" : "Workspace"}
            query={query}
            onQuery={setQuery}
            placeholder={mode === "depot" ? "Name or //depot/name" : "Filter files"}
            leading={<TreeMode mode={mode} onMode={setMode} />}
          />
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {root ? (
              <>
                <div className={fileQuery.active ? "hidden" : undefined}>
                  {mode === "depot" ? (
                    <DepotTree
                      key={`${connection?.port ?? ""}:${connection?.client ?? ""}`}
                      selected={selected}
                      onSelect={choose}
                      menu={fileMenu}
                    />
                  ) : (
                    <WorkspaceTree
                      key={root}
                      selected={selected}
                      onSelect={choose}
                      menu={fileMenu}
                    />
                  )}
                </div>
                {fileQuery.active ? (
                  fileQuery.searching ? (
                    <FileTreeSkeleton />
                  ) : (
                    <>
                      {fileQuery.result?.scope ? (
                        <p className="px-3 py-1 text-[11px] text-muted-foreground">{fileQuery.result.scope}</p>
                      ) : null}
                      {fileQuery.result?.truncated ? (
                        <p className="px-3 py-1 text-[11px] text-muted-foreground">Showing the first 200 matches.</p>
                      ) : null}
                      {fileQuery.result && fileQuery.result.hits.length === 0 ? (
                        !fileQuery.result.scope || fileQuery.result.scope.startsWith("In ") ? (
                          <p className="px-3 py-2 text-xs text-muted-foreground">No matching files.</p>
                        ) : null
                      ) : (
                      <FilteredFileTree
                        nodes={searchNodes}
                        toPath={(relative) => (mode === "depot" ? depotPath(relative) : joinRoot(root, relative))}
                        selected={selected}
                        onOpenFile={choose}
                        decorate={(node, entry) => ({
                          ...entry,
                          icon: node.dir ? undefined : <FileStatusIcon status={node.status} />,
                          iconTitle: node.detail ? <FileStatusTip text={node.detail} /> : undefined,
                        })}
                        onLoadDir={async (path) => {
                          try {
                            const next =
                              mode === "depot"
                                ? await p4.listDepot(path)
                                : await p4.listDir(relativeToRoot(root, path));
                            return next.map(presentFile);
                          } catch (caught) {
                            const message = errorMessage(caught);
                            if (message && message !== "Login cancelled") toast.error(message);
                            return null;
                          }
                        }}
                        menu={fileMenu}
                      />
                      )}
                    </>
                  )
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-file-main" defaultSize="72%" minSize="40%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-3">
            <HoverTip label={selected ? shownPath(mode, root, selected) : ""}>
              <div className="min-w-0 flex-1 truncate font-mono text-xs">
                {selected ? shownPath(mode, root, selected) : "Select a file"}
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
      <P4GetRevisionDialog path={revisionPath} onOpenChange={(open) => !open && setRevisionPath(null)} />
    </>
  );
}

function WorkspaceTree({
  selected,
  onSelect,
  menu,
}: {
  selected: string | null;
  onSelect: (path: string) => void;
  menu: (entry: FileTreeEntry) => ReactNode;
}) {
  const { connection, listDir, filesEpoch } = useP4();
  const root = connection?.root ?? "";
  const [entries, setEntries] = useState<Record<string, FileTreeEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);
  const openRef = useRef(open);
  const epochRef = useRef(filesEpoch);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

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

  useEffect(() => {
    if (epochRef.current === filesEpoch) return;
    epochRef.current = filesEpoch;
    let live = true;
    const dirs = ["", ...openRef.current];
    void Promise.all(
      [...new Set(dirs)].map(async (dir) => {
        try {
          const next = await listDir(relativeToRoot(root, dir));
          return [dir, next.map(presentFile)] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      setEntries((current) => {
        const next = { ...current };
        for (const pair of pairs) {
          if (!pair) continue;
          next[pair[0]] = pair[1];
        }
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [filesEpoch, listDir, root]);

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
      menu={menu}
    />
  );
}

function DepotTree({
  selected,
  onSelect,
  menu,
}: {
  selected: string | null;
  onSelect: (path: string) => void;
  menu: (entry: FileTreeEntry) => ReactNode;
}) {
  const { listDepot, filesEpoch } = useP4();
  const [entries, setEntries] = useState<Record<string, FileTreeEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);
  const openRef = useRef(open);
  const epochRef = useRef(filesEpoch);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    let live = true;
    void listDepot("")
      .then((next) => {
        if (live) setEntries({ "": next.map(presentFile) });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [listDepot]);

  useEffect(() => {
    if (epochRef.current === filesEpoch) return;
    epochRef.current = filesEpoch;
    let live = true;
    const dirs = ["", ...openRef.current];
    void Promise.all(
      [...new Set(dirs)].map(async (dir) => {
        try {
          const next = await listDepot(dir);
          return [dir, next.map(presentFile)] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      setEntries((current) => {
        const next = { ...current };
        for (const pair of pairs) {
          if (!pair) continue;
          next[pair[0]] = pair[1];
        }
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [filesEpoch, listDepot]);

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
        const next = await listDepot(path);
        setEntries((current) => ({ ...current, [path]: next.map(presentFile) }));
      } catch {
        return;
      }
    }
    setOpen((current) => new Set(current).add(path));
  }

  if (failed) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Could not read the depot.</p>;
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
      menu={menu}
    />
  );
}

function p4TreeTarget(path: string, dir: boolean) {
  if (!dir) return path;
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.endsWith("...")) return trimmed;
  return trimmed.startsWith("//") ? `${trimmed}/...` : `${trimmed}${trimmed.includes("\\") ? "\\" : "/"}...`;
}

function TreeMode({
  mode,
  onMode,
}: {
  mode: "workspace" | "depot";
  onMode: (mode: "workspace" | "depot") => void;
}) {
  return (
    <div role="group" aria-label="File tree" className="flex h-7 shrink-0 rounded-md bg-muted p-0.5">
      {(["workspace", "depot"] as const).map((id) => (
        <Button
          key={id}
          type="button"
          size="sm"
          variant={mode === id ? "default" : "ghost"}
          className={cn("h-6 px-2 text-xs", mode === id ? "shadow-sm" : "text-muted-foreground")}
          aria-pressed={mode === id}
          onClick={() => onMode(id)}
        >
          {id === "workspace" ? "Workspace" : "Depot"}
        </Button>
      ))}
    </div>
  );
}

function depotPath(relative: string) {
  return relative ? `//${relative}` : "";
}

function shownPath(mode: "workspace" | "depot", root: string, path: string) {
  if (mode === "depot" || path.startsWith("//")) return path;
  return relativeToRoot(root, path) || path;
}

function presentFile(entry: P4DirEntry): FileTreeEntry {
  return {
    path: entry.path,
    name: entry.name,
    dir: entry.dir,
    icon: entry.dir ? undefined : <FileStatusIcon status={entry.status} />,
    iconTitle: entry.detail ? <FileStatusTip text={entry.detail} /> : undefined,
  };
}
