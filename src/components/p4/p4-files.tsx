import { useEffect, useMemo, useState } from "react";
import { FileTree } from "@/components/file-tree";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { formatRelativeTime } from "@/lib/format";
import { changeSummary, p4ActionClass, p4ActionLetter, relativeToRoot } from "@/lib/p4";
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
  const [revisionDiff, setRevisionDiff] = useState<FileDiff | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const opened = useMemo(() => openedByLocal(p4.pending, root), [p4.pending, root]);
  const openedFile = selected ? opened.get(normalize(selected)) : undefined;

  function choose(path: string) {
    setSelected(path);
    setHistory(null);
    setRevisionDiff(null);
  }

  async function showHistory() {
    if (!selected) return;
    setHistoryLoading(true);
    setRevisionDiff(null);
    try {
      const revisions = await p4.filelog(selected);
      setHistory(revisions);
      const first = revisions[0];
      if (first?.rev) await showRevision(selected, first.rev);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function showRevision(path: string, rev: string) {
    setRevisionLoading(true);
    try {
      setRevisionDiff(await p4.revisionDiff(path, rev));
    } finally {
      setRevisionLoading(false);
    }
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-tree" defaultSize="28%" minSize="18%" maxSize="46%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">Workspace</div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {root ? (
              <WorkspaceTree key={root} selected={selected} opened={opened} onSelect={choose} />
            ) : null}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-file-main" defaultSize="72%" minSize="40%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
            <div className="min-w-0 flex-1 truncate font-mono text-xs" title={selected ?? ""}>
              {selected ? relativeToRoot(root, selected) || selected : "Select a file"}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selected}
              onClick={() => selected && void p4.fileAction("edit", [selected])}
            >
              Check out
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selected}
              onClick={() => selected && void p4.fileAction("add", [selected])}
            >
              Mark for add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selected}
              onClick={() => selected && void p4.fileAction("delete", [selected])}
            >
              Mark for delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!selected}
              onClick={() => selected && void p4.sync([selected])}
            >
              Get latest
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!selected || historyLoading}
              onClick={() => void showHistory()}
            >
              History
            </Button>
          </div>
          {history ? (
            <div className="flex min-h-0 flex-1">
              <div className="w-64 shrink-0 overflow-auto border-r">
                {history.map((revision) => (
                  <button
                    key={`${revision.rev}:${revision.change}`}
                    type="button"
                    className="block w-full border-b px-3 py-2 text-left hover:bg-muted/50"
                    onClick={() => selected && void showRevision(selected, revision.rev)}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs">#{revision.rev}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {revision.time ? formatRelativeTime(revision.time) : ""}
                      </span>
                    </div>
                    <div className="truncate text-xs">
                      {changeSummary(revision.description) || revision.action}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {revision.action} · {revision.user} · @{revision.change}
                    </div>
                  </button>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <P4Diff diff={revisionDiff} loading={revisionLoading} empty="Select a revision" />
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              {openedFile && selected ? (
                <OpenedDiff depotPath={openedFile.depotPath} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {selected
                    ? "This file is not opened. Check it out to edit it, or open History."
                    : "Browse the client root. Opened files are marked in the tree."}
                </div>
              )}
            </div>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function OpenedDiff({ depotPath }: { depotPath: string }) {
  const { selectedFile, selectFile, diff, diffLoading } = useP4();
  const active = selectedFile === depotPath;
  useEffect(() => {
    if (!active) selectFile(depotPath);
  }, [active, depotPath, selectFile]);
  return <P4Diff diff={active ? diff : null} loading={active && diffLoading} empty="Loading diff" />;
}

function WorkspaceTree({
  selected,
  opened,
  onSelect,
}: {
  selected: string | null;
  opened: Map<string, OpenedFile>;
  onSelect: (path: string) => void;
}) {
  const { connection, listDir } = useP4();
  const root = connection?.root ?? "";
  const [entries, setEntries] = useState<Record<string, P4DirEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void listDir("")
      .then((next) => {
        if (live) setEntries({ "": next });
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
        setEntries((current) => ({ ...current, [path]: next }));
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
      trailing={(entry) => {
        const action = opened.get(normalize(entry.path))?.action;
        if (!action) return null;
        return (
          <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-medium", p4ActionClass(action))} title={action}>
            {p4ActionLetter(action)}
          </span>
        );
      }}
    />
  );
}

interface OpenedFile {
  depotPath: string;
  action: string;
}

function openedByLocal(pending: { files: { localPath: string; depotPath: string; action: string }[] }[], root: string) {
  const map = new Map<string, OpenedFile>();
  for (const change of pending) {
    for (const file of change.files) {
      if (!file.localPath || !file.depotPath) continue;
      if (root && !normalize(file.localPath).startsWith(normalize(root))) continue;
      map.set(normalize(file.localPath), { depotPath: file.depotPath, action: file.action });
    }
  }
  return map;
}

function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
