import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ArrowRightLeftIcon, DownloadIcon, FilePenIcon, FolderIcon, FolderOpenIcon, FolderSearchIcon, FolderTreeIcon, GitMergeIcon, HistoryIcon, PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import { AuthorName, ExactTime, RevisionDot } from "@/components/revision-meta";
import { FileTree, FileTreeFilter, FilteredFileTree, type FileTreeEntry } from "@/components/file-tree";
import { ChangeBadge } from "@/components/p4/change-badge";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { FileStatusTip } from "@/components/p4/file-status-tip";
import { P4GetRevisionDialog } from "@/components/p4/p4-get-revision-dialog";
import { P4MoveDialog } from "@/components/p4/p4-move-dialog";
import { P4OperationDialog } from "@/components/p4/p4-operation-dialog";
import type { P4OperationKind } from "@/lib/p4-operation-preview";
import { t, useTranslation } from "@/i18n";
import { P4Diff } from "@/components/p4/p4-diff";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HoverTip } from "@/components/ui/tooltip";
import { FileTreeSkeleton, HistorySkeleton } from "@/components/skeletons";
import { normalizeRepoPath, pathsIgnoreCase } from "@/lib/format";
import { errorMessage, gitApi, isCancelled } from "@/lib/git";
import { joinRoot, type SearchNode } from "@/lib/file-search";
import { changeSummary, p4Api, relativeToRoot } from "@/lib/p4";
import { p4DisplayText } from "@/lib/p4-display";
import { useFileQuery } from "@/lib/use-file-query";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { FileDiff } from "@/types/git";
import type { P4Connection, P4DirEntry, P4EntryStatus, P4Revision } from "@/types/p4";

export function P4Files() {
  const { t } = useTranslation();
  const p4 = useP4();
  const [moving, setMoving] = useState<string | null>(null);
  const [operation, setOperation] = useState<{ kind: P4OperationKind; path: string; depot: boolean } | null>(null);
  const root = p4.connection?.root ?? "";
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"workspace" | "depot">("workspace");
  const connection = p4.connection;
  const connectionKey = JSON.stringify(connection);
  const searchFiles = useCallback(
    async (needle: string) => {
      if (!connection) return { hits: [], truncated: false, scope: "" };
      try {
        return mode === "depot"
          ? await p4Api.searchDepot(connection, needle)
          : await p4Api.searchFiles(connection, needle);
      } catch (caught) {
        const message = errorMessage(caught);
        if (message && message !== "Login cancelled" && !isCancelled(caught)) toast.error(message);
        throw caught;
      }
    },
    [connection, mode],
  );
  const fileQuery = useFileQuery(`${mode}:${connectionKey}`, query, searchFiles, mode === "depot" ? 450 : 200);
  useEffect(() => {
    const target = JSON.parse(connectionKey) as P4Connection | null;
    if (!target) return;
    const cancel = () => { void p4Api.cancelDepotSearch(target).catch(() => {}); };
    if (mode !== "depot" || !query.trim()) cancel();
    return cancel;
  }, [connectionKey, mode, query]);
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
  const [seenModes, setSeenModes] = useState(() => new Set<"workspace" | "depot">([mode]));
  if (!seenModes.has(mode)) setSeenModes((current) => new Set(current).add(mode));
  const [revisionPath, setRevisionPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<P4Revision[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [revisionDiff, setRevisionDiff] = useState<FileDiff | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const request = useRef(0);
  const diffRequest = useRef(0);
  const revealId = useRef(0);
  const [reveal, setReveal] = useState<TreeReveal | null>(null);

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

  async function revealLocation(entry: FileTreeEntry, target: "workspace" | "depot") {
    if (!connection) return;
    try {
      const located = await p4Api.locate(connection, entry.path);
      const path = target === "depot" ? located.depot : located.local;
      if (!path) {
        toast.error(t("p4.thatPathIsNotInThisWorkspace"));
        return;
      }
      setQuery("");
      setMode(target);
      setReveal({ id: ++revealId.current, mode: target, path, dir: entry.dir });
      if (entry.dir) {
        ++request.current;
        ++diffRequest.current;
        setSelected(path);
        setHistory(null);
        setSelectedRev(null);
        setRevisionDiff(null);
        setHistoryLoading(false);
        return;
      }
      choose(path);
    } catch (caught) {
      const message = errorMessage(caught);
      if (message && message !== "Login cancelled") toast.error(message);
    }
  }

  async function showInExplorer(entry: FileTreeEntry) {
    if (!connection) return;
    try {
      const local = entry.path.startsWith("//") ? (await p4Api.locate(connection, entry.path)).local : entry.path;
      if (!local) {
        toast.error(t("p4.thatPathIsNotInThisWorkspace"));
        return;
      }
      if (entry.dir) await gitApi.openInFileManager(local);
      else await gitApi.revealInFileManager(local);
    } catch (caught) {
      const message = errorMessage(caught);
      if (message && message !== "Login cancelled") toast.error(message);
    }
  }

  function fileMenu(entry: FileTreeEntry) {
    const path = p4TreeTarget(entry.path, entry.dir);
    return (
      <ContextMenuContent className="min-w-60">
        <ContextMenuItem disabled={p4.busy} onClick={() => void p4.sync([path])}>
          <DownloadIcon />{t("p4.getLatest")}</ContextMenuItem>
        <ContextMenuItem disabled={p4.busy} onClick={() => setRevisionPath(path)}>
          <HistoryIcon />{t("p4.getRevision")}</ContextMenuItem>
        {!entry.dir ? <>
          <ContextMenuItem disabled={p4.busy} onClick={() => setOperation({ kind: "integrate", path: entry.path, depot: mode === "depot" })}>
            <GitMergeIcon />{t("p4-operations.integrate.title")}
          </ContextMenuItem>
          {mode === "workspace" ? <ContextMenuItem disabled={p4.busy} onClick={() => setOperation({ kind: "undo", path: entry.path, depot: false })}>
            <Undo2Icon />{t("p4-operations.undo.title")}
          </ContextMenuItem> : null}
        </> : null}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={p4.busy} onClick={() => void p4.fileAction("edit", [path])}>
          <FilePenIcon />{t("p4.checkOut")}</ContextMenuItem>
        <ContextMenuItem disabled={p4.busy} onClick={() => void p4.fileAction("add", [path])}>
          <PlusIcon />{t("p4.markForAdd")}</ContextMenuItem>
        {mode === "workspace" && !entry.dir ? (
          <ContextMenuItem disabled={p4.busy} onClick={() => setMoving(entry.path)}>
            <ArrowRightLeftIcon />{t("p4.move.title")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem disabled={p4.busy} onClick={() => void p4.fileAction("delete", [path])}>
          <Trash2Icon />{t("p4.markForDelete")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderSearchIcon />{t("p4.showIn")}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-40">
            {mode === "workspace" ? (
              <ContextMenuItem onClick={() => void revealLocation(entry, "depot")}>
                <FolderTreeIcon />{t("p4.depot")}</ContextMenuItem>
            ) : (
              <ContextMenuItem onClick={() => void revealLocation(entry, "workspace")}>
                <FolderIcon />{t("p4.workspace")}</ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => void showInExplorer(entry)}>
              <FolderOpenIcon />{t("p4.fileExplorer")}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    );
  }

  return (
    <>
      {moving ? <P4MoveDialog key={`${connectionKey}:${moving}`} source={moving} onClose={() => setMoving(null)} onMoved={(destination) => {
        ++request.current;
        ++diffRequest.current;
        const path = joinRoot(root, pathsIgnoreCase() ? destination.replace(/\\/g, "/") : destination);
        setQuery("");
        setSelected(path);
        setHistory([]);
        setSelectedRev(null);
        setRevisionDiff(null);
        setHistoryLoading(false);
        setRevisionLoading(false);
        setReveal({ id: ++revealId.current, mode: "workspace", path, dir: false });
      }} /> : null}
      {operation ? <P4OperationDialog key={`${connectionKey}:${operation.kind}:${operation.path}`} operation={operation.kind} path={operation.path} depot={operation.depot} onClose={() => setOperation(null)} /> : null}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-tree" defaultSize="28%" minSize="18%" maxSize="46%">
        <div className="absolute inset-0 flex min-h-0 flex-col">
          <FileTreeFilter
            title={mode === "depot" ? t("p4.depot") : t("p4.workspace")}
            query={query}
            onQuery={setQuery}
            placeholder={mode === "depot" ? t("p4.nameOrDepotname") : t("p4.filterFiles")}
            leading={<TreeMode mode={mode} onMode={setMode} />}
          />
          <div className="relative min-h-0 flex-1 overflow-auto py-1">
            {root ? (
              <>
                <div className={fileQuery.active || mode !== "workspace" ? "hidden" : undefined}>
                  {seenModes.has("workspace") ? (
                    <WorkspaceTree
                      key={root}
                      selected={selected}
                      onSelect={choose}
                      onResolved={setSelected}
                      reveal={reveal?.mode === "workspace" ? reveal : null}
                      menu={fileMenu}
                    />
                  ) : null}
                </div>
                <div className={fileQuery.active || mode !== "depot" ? "hidden" : undefined}>
                  {seenModes.has("depot") ? (
                    <DepotTree
                      key={`${connection?.port ?? ""}:${connection?.client ?? ""}`}
                      selected={selected}
                      onSelect={choose}
                      onResolved={setSelected}
                      reveal={reveal?.mode === "depot" ? reveal : null}
                      menu={fileMenu}
                    />
                  ) : null}
                </div>
                {fileQuery.active ? (
                    fileQuery.searching ? (
                    <FileTreeSkeleton fill label={t("p4.searchingFiles")} />
                  ) : (
                    <>
                      {fileQuery.result?.scope ? (
                        <p className="px-3 py-1 text-[11px] text-muted-foreground">{p4DisplayText(fileQuery.result.scope)}</p>
                      ) : null}
                      {fileQuery.result?.truncated ? (
                        <p className="px-3 py-1 text-[11px] text-muted-foreground">{t("p4.showingTheFirst200Matches")}</p>
                      ) : null}
                      {fileQuery.result && fileQuery.result.hits.length === 0 ? (
                        !fileQuery.result.scope || fileQuery.result.scope.startsWith("In ") ? (
                          <p className="px-3 py-2 text-xs text-muted-foreground">{t("p4.noMatchingFiles")}</p>
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
                          if (!connection) return null;
                          try {
                            const depot = mode === "depot";
                            const next = depot
                              ? await p4.listDepot(path)
                              : await p4.listDir(relativeToRoot(root, path));
                            const shown = next.map(presentFile);
                            try {
                              const statuses = await p4Api.listingStatus(connection, path, depot);
                              return mergeListingStatus(shown, statuses, depot);
                            } catch {
                              return shown;
                            }
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
        <div className="absolute inset-0 flex min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-3">
            <HoverTip label={selected ? shownPath(mode, root, selected) : ""}>
              <div className="min-w-0 flex-1 truncate font-mono text-xs">
                {selected ? shownPath(mode, root, selected) : t("p4.selectAFile")}
              </div>
            </HoverTip>
          </div>
          {selected ? (
            <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0 flex-1">
              <ResizablePanel id="p4-file-history" defaultSize="34%" minSize="16%">
                <div className="absolute inset-0 overflow-auto px-1 py-1">
                  {historyLoading && !history ? (
                    <HistorySkeleton fill label={t("p4.loadingHistory")} />
                  ) : history && history.length === 0 ? (
                    <p className="p-3 text-xs text-muted-foreground">{t("p4.noRevisions")}</p>
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
                        <RevisionDot />
                        <ChangeBadge id={revision.rev} />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {changeSummary(revision.description) || t("p4.noDescription")}
                        </span>
                        <AuthorName name={revision.user} />
                        <ExactTime time={revision.time} />
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
                  empty={t("p4.noRevisionToShow")}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{t("p4.openAFileToSeeItsHistory")}</div>
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
  onResolved,
  reveal,
  menu,
}: {
  selected: string | null;
  onSelect: (path: string) => void;
  onResolved: (path: string) => void;
  reveal: TreeReveal | null;
  menu: (entry: FileTreeEntry) => ReactNode;
}) {
  useTranslation();
  const { connection, listDir, filesEpoch } = useP4();
  const root = connection?.root ?? "";
  const cacheKey = treeCacheKey("workspace", connection);
  const cached = cacheKey ? treeSnapshots.get(cacheKey) : undefined;
  const [entries, setEntries] = useState<Record<string, FileTreeEntry[]>>(() => cached?.entries ?? {});
  const [open, setOpen] = useState<Set<string>>(() => new Set(cached?.open ?? []));
  const [failed, setFailed] = useState(false);
  const openRef = useRef(open);
  const epochRef = useRef(filesEpoch);
  const liveRef = useRef(true);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!cacheKey || !entries[""]) return;
    treeSnapshots.set(cacheKey, { entries, open: [...open] });
  }, [cacheKey, entries, open]);

  useEffect(() => {
    let live = true;
    void publishDirectory("", false, connection, () => listDir(""), setEntries, () => live && liveRef.current).catch(
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [connection, listDir]);

  useEffect(() => {
    if (epochRef.current === filesEpoch) return;
    epochRef.current = filesEpoch;
    let live = true;
    const dirs = ["", ...openRef.current];
    for (const dir of new Set(dirs)) {
      void publishDirectory(
        dir,
        false,
        connection,
        () => listDir(dir ? relativeToRoot(root, dir) : ""),
        setEntries,
        () => live && liveRef.current,
      ).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [connection, filesEpoch, listDir, root]);

  const loadWorkspace = useCallback(
    (dir: string) => listDir(dir ? relativeToRoot(root, dir) : ""),
    [listDir, root],
  );
  useRevealTree(reveal, loadWorkspace, setEntries, setOpen, onResolved, (directories) => {
    for (const directory of directories) {
      void annotateDirectory(directory, false, connection, setEntries, () => liveRef.current);
    }
  });

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
        await publishDirectory(
          path,
          false,
          connection,
          () => listDir(relativeToRoot(root, path)),
          setEntries,
          () => liveRef.current,
        );
      } catch {
        return;
      }
    }
    setOpen((current) => new Set(current).add(path));
  }

  if (!entries[""]) {
    if (failed) {
      return <p className="px-3 py-2 text-xs text-muted-foreground">{t("p4.couldNotReadTheWorkspaceFolder")}</p>;
    }
    return <FileTreeSkeleton fill label={t("p4.loadingWorkspace")} />;
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
  onResolved,
  reveal,
  menu,
}: {
  selected: string | null;
  onSelect: (path: string) => void;
  onResolved: (path: string) => void;
  reveal: TreeReveal | null;
  menu: (entry: FileTreeEntry) => ReactNode;
}) {
  useTranslation();
  const { connection, listDepot, filesEpoch } = useP4();
  const cacheKey = treeCacheKey("depot", connection);
  const cached = cacheKey ? treeSnapshots.get(cacheKey) : undefined;
  const [entries, setEntries] = useState<Record<string, FileTreeEntry[]>>(() => cached?.entries ?? {});
  const [open, setOpen] = useState<Set<string>>(() => new Set(cached?.open ?? []));
  const [failed, setFailed] = useState(false);
  const openRef = useRef(open);
  const epochRef = useRef(filesEpoch);
  const liveRef = useRef(true);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!cacheKey || !entries[""]) return;
    treeSnapshots.set(cacheKey, { entries, open: [...open] });
  }, [cacheKey, entries, open]);

  useEffect(() => {
    let live = true;
    void publishDirectory("", true, connection, () => listDepot(""), setEntries, () => live && liveRef.current).catch(
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [connection, listDepot]);

  useEffect(() => {
    if (epochRef.current === filesEpoch) return;
    epochRef.current = filesEpoch;
    let live = true;
    const dirs = ["", ...openRef.current];
    for (const dir of new Set(dirs)) {
      void publishDirectory(dir, true, connection, () => listDepot(dir), setEntries, () => live && liveRef.current).catch(
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [connection, filesEpoch, listDepot]);

  useRevealTree(reveal, listDepot, setEntries, setOpen, onResolved, (directories) => {
    for (const directory of directories) {
      void annotateDirectory(directory, true, connection, setEntries, () => liveRef.current);
    }
  });

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
        await publishDirectory(path, true, connection, () => listDepot(path), setEntries, () => liveRef.current);
      } catch {
        return;
      }
    }
    setOpen((current) => new Set(current).add(path));
  }

  if (!entries[""]) {
    if (failed) {
      return <p className="px-3 py-2 text-xs text-muted-foreground">{t("p4.couldNotReadTheDepot")}</p>;
    }
    return <FileTreeSkeleton fill label={t("p4.loadingDepot")} />;
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
  useTranslation();
  return (
    <SegmentedControl
      label={t("p4.fileTree")}
      value={mode}
      onChange={onMode}
      options={[
        { value: "workspace", label: t("p4.workspace") },
        { value: "depot", label: t("p4.depot") },
      ]}
    />
  );
}

function depotPath(relative: string) {
  return relative ? `//${relative}` : "";
}

function shownPath(mode: "workspace" | "depot", root: string, path: string) {
  if (mode === "depot" || path.startsWith("//")) return path;
  return relativeToRoot(root, path) || path;
}

type TreeReveal = {
  id: number;
  mode: "workspace" | "depot";
  path: string;
  dir: boolean;
};

function useRevealTree(
  reveal: TreeReveal | null,
  load: (dir: string) => Promise<P4DirEntry[]>,
  setEntries: Dispatch<SetStateAction<Record<string, FileTreeEntry[]>>>,
  setOpen: Dispatch<SetStateAction<Set<string>>>,
  onResolved: (path: string) => void,
  onExpanded?: (directories: string[]) => void,
) {
  const resolvedRef = useRef(onResolved);
  const expandedRef = useRef(onExpanded);
  useEffect(() => {
    resolvedRef.current = onResolved;
  }, [onResolved]);
  useEffect(() => {
    expandedRef.current = onExpanded;
  }, [onExpanded]);
  useEffect(() => {
    if (!reveal) return;
    let live = true;
    void expandTree(async (dir) => (await load(dir)).map(presentFile), reveal.path, reveal.dir)
      .then((result) => {
        if (!live) return;
        setEntries((current) => {
          const next = { ...current };
          for (const [dir, list] of Object.entries(result.entries)) {
            next[dir] = keepKnownIcons(current[dir], list);
          }
          return next;
        });
        setOpen((current) => {
          const next = new Set(current);
          for (const dir of result.open) next.add(dir);
          return next;
        });
        expandedRef.current?.(Object.keys(result.entries));
        if (result.path !== reveal.path) resolvedRef.current(result.path);
        scrollTreePath(result.path);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [reveal, load, setEntries, setOpen]);
}

function normalizeTreePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function expandTree(
  load: (dir: string) => Promise<FileTreeEntry[]>,
  target: string,
  openTarget: boolean,
) {
  const entries: Record<string, FileTreeEntry[]> = {};
  const open: string[] = [];
  const wanted = normalizeTreePath(target);
  let current = "";
  for (let depth = 0; depth < 40; depth += 1) {
    let children: FileTreeEntry[];
    try {
      children = await load(current);
    } catch {
      return { entries, open, path: target };
    }
    entries[current] = children;
    const exact = children.find((child) => normalizeTreePath(child.path) === wanted);
    if (exact) {
      if (openTarget && exact.dir) {
        open.push(exact.path);
        try {
          entries[exact.path] = await load(exact.path);
        } catch {
          // The folder stays selected even if its contents cannot be read.
        }
      }
      return { entries, open, path: exact.path };
    }
    const next = children.find(
      (child) => child.dir && wanted.startsWith(`${normalizeTreePath(child.path)}/`),
    );
    if (!next || next.path === current) return { entries, open, path: target };
    open.push(next.path);
    current = next.path;
  }
  return { entries, open, path: target };
}

function scrollTreePath(path: string) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelector(`[data-tree-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  });
}

type TreeSnapshot = {
  entries: Record<string, FileTreeEntry[]>;
  open: string[];
};

const treeSnapshots = new Map<string, TreeSnapshot>();

function treeCacheKey(mode: "workspace" | "depot", connection: P4Connection | null) {
  if (!connection) return "";
  return `${mode}\0${connection.port}\0${connection.client}\0${connection.root}`;
}

function publishDirectory(
  directory: string,
  depot: boolean,
  connection: P4Connection | null,
  load: () => Promise<P4DirEntry[]>,
  setEntries: Dispatch<SetStateAction<Record<string, FileTreeEntry[]>>>,
  live: () => boolean,
) {
  return load().then((next) => {
    if (!live()) return;
    const shown = next.map(presentFile);
    setEntries((current) => ({ ...current, [directory]: keepKnownIcons(current[directory], shown) }));
    void annotateDirectory(directory, depot, connection, setEntries, live);
  });
}

function annotateDirectory(
  directory: string,
  depot: boolean,
  connection: P4Connection | null,
  setEntries: Dispatch<SetStateAction<Record<string, FileTreeEntry[]>>>,
  live: () => boolean,
) {
  if (!connection || (depot && !directory)) return Promise.resolve();
  return p4Api
    .listingStatus(connection, directory, depot)
    .then((statuses) => {
      if (!live()) return;
      setEntries((current) => {
        const existing = current[directory];
        if (!existing) return current;
        return { ...current, [directory]: mergeListingStatus(existing, statuses, depot) };
      });
    })
    .catch(() => {});
}

function keepKnownIcons(previous: FileTreeEntry[] | undefined, next: FileTreeEntry[]) {
  if (!previous) return next;
  const prior = new Map(previous.map((entry) => [entry.path, entry]));
  return next.map((entry) => {
    const known = prior.get(entry.path);
    if (!known?.icon) return entry;
    return { ...entry, icon: known.icon, iconTitle: known.iconTitle };
  });
}

function mergeListingStatus(entries: FileTreeEntry[], statuses: P4EntryStatus[], depot: boolean): FileTreeEntry[] {
  if (statuses.length === 0) return entries;
  const byPath = new Map<string, P4EntryStatus>();
  const byName = new Map<string, P4EntryStatus>();
  const nameKey = (name: string) => pathsIgnoreCase() ? name.toLowerCase() : name;
  for (const status of statuses) {
    byPath.set(normalizeRepoPath(status.path), status);
    const name = nameKey(status.path.split(pathsIgnoreCase() ? /[/\\]/ : /\//).pop() ?? "");
    if (name) byName.set(name, status);
  }
  return entries.map((entry) => {
    if (entry.dir) return entry;
    const found = byPath.get(normalizeRepoPath(entry.path)) ?? byName.get(nameKey(entry.name));
    if (!found && depot) return entry;
    const status = found?.status ?? "local";
    const detail = found?.detail || (found ? "" : "Not in the depot");
    return {
      ...entry,
      icon: <FileStatusIcon status={status} />,
      iconTitle: detail ? <FileStatusTip text={detail} /> : undefined,
    };
  });
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
