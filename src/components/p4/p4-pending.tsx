import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, GitMergeIcon, PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { ChangeBadge } from "@/components/p4/change-badge";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { FileStatusTip, fileStatusText } from "@/components/p4/file-status-tip";
import { P4Diff } from "@/components/p4/p4-diff";
import { P4Resolve } from "@/components/p4/p4-resolve";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { changeSummary, depotBase, p4ActionStatus } from "@/lib/p4";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";

export function P4Pending() {
  const p4 = useP4();
  const selected = p4.pending.find((change) => change.id === p4.selectedChange) ?? null;
  const opened = selected?.files.filter((file) => !file.shelved) ?? [];
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [shelvedOpen, setShelvedOpen] = useState<Set<string>>(() => new Set());
  const [revertRequest, setRevertRequest] = useState<RevertRequest | null>(null);
  const [deletingShelf, setDeletingShelf] = useState(false);
  const [resolving, setResolving] = useState<{ change: string; path: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [dragKind, setDragKind] = useState<"open" | "shelf" | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragFiles = useRef<PendingDragFile[] | null>(null);
  const anchor = useRef<string | null>(null);
  const didDrag = useRef(false);
  const pointerDrag = useRef<(() => void) | null>(null);
  const resolvingPath = resolving?.change === p4.selectedChange ? resolving.path : null;
  const openChanges = expanded ?? new Set(p4.selectedChange ? [p4.selectedChange] : []);

  function toggleShelved(id: string) {
    setShelvedOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleChange(id: string) {
    setExpanded((current) => {
      const next = new Set(current ?? openChanges);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function focusChange(id: string) {
    setExpanded((current) => new Set(current ?? openChanges).add(id));
    if (id !== p4.selectedChange) setResolving(null);
    p4.selectChange(id);
  }

  function chooseFile(id: string, path: string, shelved: boolean) {
    if (id !== p4.selectedChange) {
      setResolving(null);
      p4.selectChange(id);
    } else if (!shelved) {
      setResolving((current) => (current?.path === path ? current : null));
    }
    p4.selectFile(path, shelved);
  }

  function rowsInOrder() {
    const rows: PendingDragFile[] = [];
    for (const change of p4.pending) {
      if (!openChanges.has(change.id)) continue;
      for (const file of change.files) {
        if (!file.shelved) rows.push({ change: change.id, path: file.depotPath, shelved: false });
      }
      if (shelvedOpen.has(change.id)) {
        for (const file of change.files) {
          if (file.shelved) rows.push({ change: change.id, path: file.depotPath, shelved: true });
        }
      }
    }
    return rows;
  }

  function pickFile(event: MouseEvent, file: PendingDragFile) {
    if (didDrag.current) return;
    const key = rowKey(file);
    const ordered = rowsInOrder().map(rowKey);
    if (event.shiftKey && anchor.current) {
      const start = ordered.indexOf(anchor.current);
      const end = ordered.indexOf(key);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setPicked(ordered.slice(from, to + 1));
        chooseFile(file.change, file.path, file.shelved);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setPicked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
    } else {
      setPicked([key]);
    }
    anchor.current = key;
    chooseFile(file.change, file.path, file.shelved);
  }

  useEffect(() => {
    return () => {
      pointerDrag.current?.();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  function beginPointer(event: ReactPointerEvent, file: PendingDragFile) {
    if (event.button !== 0) return;
    pointerDrag.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (dx * dx + dy * dy < 16) return;
        dragging = true;
        didDrag.current = true;
        const key = rowKey(file);
        const chosen = picked.includes(key)
          ? rowsInOrder().filter((row) => row.shelved === file.shelved && picked.includes(rowKey(row)))
          : [file];
        dragFiles.current = chosen.length > 0 ? chosen : [file];
        setDragKind(file.shelved ? "shelf" : "open");
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      const next = highlightAt(ev.clientX, ev.clientY, dragFiles.current);
      setDropTarget((current) => (current === next ? current : next));
    };

    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop();
      const files = dragFiles.current;
      const target = dragging ? zoneAt(ev.clientX, ev.clientY) : null;
      dragFiles.current = null;
      setDragKind(null);
      setDropTarget(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.setTimeout(() => {
        didDrag.current = false;
      }, 0);
      if (!dragging || !files || !target || !acceptsDrop(files, target.change, target.shelf)) return;
      if (target.shelf) {
        setShelvedOpen((current) => new Set(current).add(target.change));
        setExpanded((current) => new Set(current ?? openChanges).add(target.change));
      }
      setPicked([]);
      void p4.placeFiles(files, target.change, target.shelf);
    };

    const stop = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      if (pointerDrag.current === stop) pointerDrag.current = null;
    };

    pointerDrag.current = stop;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  }

  function openedMenu(entry: PendingFile, file: PendingDragFile) {
    const targets = openedSelection(p4.pending, picked, file);
    const canShelve = targets.some((item) => item.change !== "default");
    return (
      <ContextMenuContent className="w-36">
        {entry.status === "conflict" ? (
          <>
            <ContextMenuItem
              onClick={() => {
                chooseFile(file.change, file.path, false);
                setResolving({ change: file.change, path: file.path });
              }}
            >
              <GitMergeIcon />
              Resolve
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            const next = openedSelection(p4.pending, picked, file);
            setRevertRequest({
              paths: next.filter((item) => p4ActionStatus(item.action) !== "add").map((item) => item.path),
              wipe: next.filter((item) => p4ActionStatus(item.action) === "add").map((item) => item.path),
            });
          }}
        >
          <Undo2Icon />
          Revert
        </ContextMenuItem>
        {canShelve ? (
          <ContextMenuItem
            onClick={() => {
              void shelveOpened(openedSelection(p4.pending, picked, file));
            }}
          >
            <ArchiveIcon />
            Shelve
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    );
  }

  async function shelveOpened(files: { change: string; path: string }[]) {
    const ok = await p4.shelveFiles(files);
    if (!ok) return;
    setShelvedOpen((current) => {
      const next = new Set(current);
      for (const file of files) {
        if (file.change !== "default") next.add(file.change);
      }
      return next;
    });
    setExpanded((current) => {
      const next = new Set(current ?? openChanges);
      for (const file of files) {
        if (file.change !== "default") next.add(file.change);
      }
      return next;
    });
    setPicked([]);
  }

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
        <ResizablePanel id="p4-pending-tree" defaultSize="42%" minSize="26%" maxSize="68%">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
              <span className="text-sm font-medium">Pending</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => setCreating(true)}>
                <PlusIcon />
                New
              </Button>
            </div>
            <div className={cn("min-h-0 flex-1 overflow-auto px-1 py-1", dragKind && "[&_*]:cursor-grabbing")}>
              {p4.pending.map((change) => {
                const changeOpened = change.files.filter((file) => !file.shelved);
                const changeShelved = change.files.filter((file) => file.shelved);
                const summary = changeSummary(change.description);
                const open = openChanges.has(change.id);
                const active = change.id === p4.selectedChange;
                const selectedPath = active ? p4.selectedFile : null;
                const showShelf = open && change.id !== "default";
                return (
                  <div key={change.id}>
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            "flex items-center rounded-md pr-2 hover:bg-muted/70",
                            active && "bg-muted",
                            dropTarget === `open:${change.id}` && "bg-accent ring-1 ring-foreground/25 ring-inset",
                          )}
                          data-drop="open"
                          data-change={change.id}
                        >
                          <button
                            type="button"
                            className="flex size-7 shrink-0 items-center justify-center"
                            aria-expanded={open}
                            aria-label={open ? "Collapse changelist" : "Expand changelist"}
                            onClick={() => {
                              if (didDrag.current) return;
                              toggleChange(change.id);
                            }}
                          >
                            <ChevronDownIcon
                              className={cn(
                                "size-3.5 text-muted-foreground transition-transform",
                                !open && "-rotate-90",
                              )}
                            />
                          </button>
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
                            onClick={() => {
                              if (didDrag.current) return;
                              focusChange(change.id);
                            }}
                          >
                            <ChangeBadge id={change.id} />
                            <span className="min-w-0 flex-1 truncate text-xs">{summary || "No description"}</span>
                          </button>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-36">
                        <ContextMenuItem
                          disabled={change.id === "default" || changeOpened.length === 0}
                          onClick={() => {
                            p4.selectChange(change.id);
                            void p4.shelveSelected();
                          }}
                        >
                          <ArchiveIcon />
                          Shelve
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    {open ? (
                      <>
                        <div
                          className={cn(dropTarget === `open:${change.id}` && "rounded-md bg-accent/60")}
                          data-drop="open"
                          data-change={change.id}
                        >
                          <PendingFiles
                            changeId={change.id}
                            files={changeOpened}
                            picked={picked}
                            selectedPath={selectedPath}
                            selectedShelved={p4.selectedShelved}
                            className="pl-7"
                            onSelect={(event, path) => pickFile(event, { change: change.id, path, shelved: false })}
                            onResolve={(path) => {
                              chooseFile(change.id, path, false);
                              setResolving({ change: change.id, path });
                            }}
                            onPointerDown={beginPointer}
                            onContextMenu={(file) => {
                              const key = rowKey(file);
                              if (picked.includes(key)) return;
                              setPicked([key]);
                              anchor.current = key;
                              chooseFile(file.change, file.path, false);
                            }}
                            menu={openedMenu}
                          />
                        </div>
                        {showShelf ? (
                          <div
                            className={cn(
                              dropTarget === `shelf:${change.id}` && "rounded-md bg-accent ring-1 ring-foreground/25 ring-inset",
                            )}
                            data-drop="shelf"
                            data-change={change.id}
                          >
                          <FileGroup
                            title="Shelved"
                            changeId={change.id}
                            open={shelvedOpen.has(change.id)}
                            files={changeShelved}
                            picked={picked}
                            selectedPath={selectedPath}
                            selectedShelved={p4.selectedShelved}
                            onToggle={() => {
                              if (didDrag.current) return;
                              toggleShelved(change.id);
                            }}
                            onSelect={(event, path) => pickFile(event, { change: change.id, path, shelved: true })}
                            onPointerDown={beginPointer}
                            menu={
                              changeShelved.length === 0 ? undefined : (
                              <ContextMenuContent className="w-36">
                                <ContextMenuItem
                                  onClick={() => {
                                    p4.selectChange(change.id);
                                    void p4.unshelveSelected();
                                  }}
                                >
                                  <ArchiveRestoreIcon />
                                  Unshelve
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  variant="destructive"
                                  onClick={() => {
                                    p4.selectChange(change.id);
                                    setDeletingShelf(true);
                                  }}
                                >
                                  <Trash2Icon />
                                  Delete
                                </ContextMenuItem>
                              </ContextMenuContent>
                              )
                            }
                          />
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="shrink-0 border-t p-3">
              <Textarea
                value={p4.description}
                onChange={(event) => p4.setDescription(event.target.value)}
                placeholder="Changelist description"
                className="min-h-20 text-sm"
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  disabled={!p4.description.trim() || opened.length === 0}
                  onClick={() => void p4.submitSelected()}
                >
                  Submit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={opened.length === 0}
                  onClick={() => setRevertRequest({ paths: opened.map((file) => file.depotPath), wipe: [] })}
                >
                  Revert
                </Button>
              </div>
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="p4-diff" defaultSize="58%" minSize="30%">
          {resolvingPath ? (
            <P4Resolve key={resolvingPath} path={resolvingPath} onResolved={() => setResolving(null)} />
          ) : (
            <P4Diff
              diff={p4.diff}
              loading={p4.diffLoading}
              empty={p4.selectedFile ? "Loading diff" : "Select a file to see its diff"}
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
      <NewChangeDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={(description) => void p4.createChange(description)}
      />
      <RevertDialog
        request={revertRequest}
        onOpenChange={(open) => !open && setRevertRequest(null)}
        onConfirm={() => {
          const request = revertRequest;
          setRevertRequest(null);
          if (!request) return;
          setPicked([]);
          void p4.revertPaths(request.paths, request.wipe);
        }}
      />
      <DeleteShelfDialog
        open={deletingShelf}
        onOpenChange={setDeletingShelf}
        onConfirm={() => {
          setDeletingShelf(false);
          void p4.deleteSelectedShelf();
        }}
      />
    </>
  );
}

type PendingFile = {
  depotPath: string;
  action: string;
  shelved: boolean;
  status: string;
  detail: string;
};

type PendingDragFile = { change: string; path: string; shelved: boolean };

type RevertRequest = { paths: string[]; wipe: string[] };

function openedSelection(
  pending: { id: string; files: PendingFile[] }[],
  picked: string[],
  file: PendingDragFile,
) {
  const key = rowKey(file);
  const keys = new Set(picked.includes(key) ? picked : [key]);
  const found: { change: string; path: string; action: string }[] = [];
  for (const change of pending) {
    for (const item of change.files) {
      if (item.shelved) continue;
      const row = { change: change.id, path: item.depotPath, shelved: false };
      if (!keys.has(rowKey(row))) continue;
      found.push({ change: change.id, path: item.depotPath, action: item.action });
    }
  }
  return found.length > 0 ? found : [{ change: file.change, path: file.path, action: "" }];
}

function FileGroup({
  title,
  changeId,
  open,
  files,
  picked,
  selectedPath,
  selectedShelved,
  onToggle,
  onSelect,
  onPointerDown,
  menu,
}: {
  title: string;
  changeId: string;
  open: boolean;
  files: PendingFile[];
  picked: string[];
  selectedPath: string | null;
  selectedShelved: boolean;
  onToggle: () => void;
  onSelect: (event: MouseEvent, path: string) => void;
  onPointerDown: (event: ReactPointerEvent, file: PendingDragFile) => void;
  menu?: ReactNode;
}) {
  const header = (
    <button
      type="button"
      className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 pl-7 text-left hover:bg-muted/70"
      onClick={onToggle}
      aria-expanded={open}
    >
      <ChevronDownIcon className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      <span className="text-xs font-medium">{title}</span>
      <span className="tabular-nums text-xs text-muted-foreground">{files.length}</span>
    </button>
  );
  return (
    <div>
      {menu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          {menu}
        </ContextMenu>
      ) : (
        header
      )}
      {open ? (
        <PendingFiles
          changeId={changeId}
          files={files}
          picked={picked}
          selectedPath={selectedPath}
          selectedShelved={selectedShelved}
          className="pl-12"
          onSelect={onSelect}
          onPointerDown={onPointerDown}
        />
      ) : null}
    </div>
  );
}

function PendingFiles({
  changeId,
  files,
  picked,
  selectedPath,
  selectedShelved,
  className,
  onSelect,
  onResolve,
  onPointerDown,
  onContextMenu,
  menu,
}: {
  changeId: string;
  files: PendingFile[];
  picked: string[];
  selectedPath: string | null;
  selectedShelved: boolean;
  className: string;
  onSelect: (event: MouseEvent, path: string) => void;
  onResolve?: (path: string) => void;
  onPointerDown: (event: ReactPointerEvent, file: PendingDragFile) => void;
  onContextMenu?: (file: PendingDragFile) => void;
  menu?: (entry: PendingFile, file: PendingDragFile) => ReactNode;
}) {
  return files.map((file) => {
    const drag = { change: changeId, path: file.depotPath, shelved: file.shelved };
    const active =
      picked.length > 0
        ? picked.includes(rowKey(drag))
        : file.depotPath === selectedPath && file.shelved === selectedShelved;
    const row = (
      <button
        type="button"
        className={cn(
          "flex w-full cursor-grab items-center gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-muted/70",
          className,
          active && "bg-muted",
        )}
        onClick={(event) => onSelect(event, file.depotPath)}
        onPointerDown={(event) => onPointerDown(event, drag)}
        onContextMenu={() => onContextMenu?.(drag)}
      >
        <FileStatusIcon status={file.status || p4ActionStatus(file.action)} className="mr-1" />
        <span className="min-w-0 flex-1 truncate font-mono">{depotBase(file.depotPath)}</span>
      </button>
    );
    const tip = fileTip(file) ? <FileStatusTip text={fileTip(file)} /> : undefined;
    const key = `${file.depotPath}:${file.shelved ? "shelf" : "open"}`;
    if (menu) {
      return (
        <ContextMenu key={key}>
          <HoverTip className="max-w-lg" label={tip}>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          </HoverTip>
          {menu(file, drag)}
        </ContextMenu>
      );
    }
    if (file.status === "conflict" && onResolve) {
      const resolve = onResolve;
      return (
        <ContextMenu key={key}>
          <HoverTip className="max-w-lg" label={tip}>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          </HoverTip>
          <ContextMenuContent className="w-36">
            <ContextMenuItem onClick={() => resolve(file.depotPath)}>
              <GitMergeIcon />
              Resolve
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      );
    }
    return (
      <HoverTip key={key} className="max-w-lg" label={tip}>
        {row}
      </HoverTip>
    );
  });
}

function rowKey(file: PendingDragFile) {
  return `${file.change}\n${file.path}\n${file.shelved ? "1" : "0"}`;
}

function zoneAt(x: number, y: number) {
  const hit = document.elementFromPoint(x, y);
  const zone = hit instanceof Element ? hit.closest("[data-drop]") : null;
  if (!(zone instanceof HTMLElement)) return null;
  const kind = zone.dataset.drop;
  const change = zone.dataset.change;
  if ((kind !== "open" && kind !== "shelf") || !change) return null;
  return { change, shelf: kind === "shelf" };
}

function highlightAt(x: number, y: number, files: PendingDragFile[] | null) {
  const target = zoneAt(x, y);
  if (!target || !acceptsDrop(files, target.change, target.shelf)) return null;
  return `${target.shelf ? "shelf" : "open"}:${target.change}`;
}

function acceptsDrop(files: PendingDragFile[] | null, targetChange: string, shelf: boolean) {
  if (!files || files.length === 0) return false;
  const shelved = files[0].shelved;
  if (files.some((file) => file.shelved !== shelved)) return false;
  if (shelf && targetChange === "default") return false;
  if (shelf && shelved && files.every((file) => file.change === targetChange)) return false;
  if (!shelf && !shelved && files.every((file) => file.change === targetChange)) return false;
  return true;
}

function fileTip(file: { depotPath: string; detail: string; action: string }) {
  return fileStatusText(file.depotPath, file.detail, file.action);
}

function NewChangeDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (description: string) => void;
}) {
  const [description, setDescription] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDescription("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New changelist</DialogTitle>
          <DialogDescription>Creates an empty numbered changelist on this client.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={description}
          autoFocus
          placeholder="Description"
          onChange={(event) => setDescription(event.target.value)}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!description.trim()}
            onClick={() => {
              onCreate(description.trim());
              setDescription("");
              onOpenChange(false);
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteShelfDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete shelf?</DialogTitle>
          <DialogDescription>
            This removes the shelved files for this changelist from the server. Opened files stay in the workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevertDialog({
  request,
  onOpenChange,
  onConfirm,
}: {
  request: RevertRequest | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const restored = request?.paths.length ?? 0;
  const wiped = request?.wipe.length ?? 0;
  const count = restored + wiped;
  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revert {count === 1 ? "file" : `${count} files`}?</DialogTitle>
          <DialogDescription>
            {wiped === 0
              ? "This discards the opened changes and restores the have revision. A shelf on the server is left in place."
              : restored === 0
                ? "This removes the added files from the changelist and deletes them from disk."
                : "Added files are deleted from disk. Other opened files go back to the revision you have."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Revert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
