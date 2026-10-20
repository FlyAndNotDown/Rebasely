import { useState, type ReactNode } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, GitMergeIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { changeSummary, depotBase } from "@/lib/p4";
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
  const [revertPaths, setRevertPaths] = useState<string[] | null>(null);
  const [deletingShelf, setDeletingShelf] = useState(false);
  const [resolving, setResolving] = useState<{ change: string; path: string } | null>(null);
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
            <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
              {p4.pending.map((change) => {
                const changeOpened = change.files.filter((file) => !file.shelved);
                const changeShelved = change.files.filter((file) => file.shelved);
                const summary = changeSummary(change.description);
                const open = openChanges.has(change.id);
                const active = change.id === p4.selectedChange;
                const selectedPath = active ? p4.selectedFile : null;
                return (
                  <div key={change.id}>
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            "flex items-center rounded-md pr-2 hover:bg-muted/70",
                            active && "bg-muted",
                          )}
                        >
                          <button
                            type="button"
                            className="flex size-7 shrink-0 items-center justify-center"
                            aria-expanded={open}
                            aria-label={open ? "Collapse changelist" : "Expand changelist"}
                            onClick={() => toggleChange(change.id)}
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
                            onClick={() => focusChange(change.id)}
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
                        <PendingFiles
                          files={changeOpened}
                          selectedPath={selectedPath}
                          selectedShelved={p4.selectedShelved}
                          className="pl-7"
                          onSelect={(path) => chooseFile(change.id, path, false)}
                          onResolve={(path) => {
                            chooseFile(change.id, path, false);
                            setResolving({ change: change.id, path });
                          }}
                        />
                        {changeShelved.length > 0 ? (
                          <FileGroup
                            title="Shelved"
                            open={shelvedOpen.has(change.id)}
                            files={changeShelved}
                            selectedPath={selectedPath}
                            selectedShelved={p4.selectedShelved}
                            onToggle={() => toggleShelved(change.id)}
                            onSelect={(path) => chooseFile(change.id, path, true)}
                            menu={
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
                            }
                          />
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
                  onClick={() => setRevertPaths(opened.map((file) => file.depotPath))}
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
        paths={revertPaths}
        onOpenChange={(open) => !open && setRevertPaths(null)}
        onConfirm={() => {
          const paths = revertPaths ?? [];
          setRevertPaths(null);
          void p4.revertPaths(paths);
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

function FileGroup({
  title,
  open,
  files,
  selectedPath,
  selectedShelved,
  onToggle,
  onSelect,
  menu,
}: {
  title: string;
  open: boolean;
  files: PendingFile[];
  selectedPath: string | null;
  selectedShelved: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
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
          files={files}
          selectedPath={selectedPath}
          selectedShelved={selectedShelved}
          className="pl-12"
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}

function PendingFiles({
  files,
  selectedPath,
  selectedShelved,
  className,
  onSelect,
  onResolve,
}: {
  files: PendingFile[];
  selectedPath: string | null;
  selectedShelved: boolean;
  className: string;
  onSelect: (path: string) => void;
  onResolve?: (path: string) => void;
}) {
  return files.map((file) => {
    const active = file.depotPath === selectedPath && file.shelved === selectedShelved;
    const row = (
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-muted/70",
          className,
          active && "bg-muted",
        )}
        onClick={() => onSelect(file.depotPath)}
      >
        <FileStatusIcon status={file.status || actionStatus(file.action)} className="mr-1" />
        <span className="min-w-0 flex-1 truncate font-mono">{depotBase(file.depotPath)}</span>
      </button>
    );
    const tip = fileTip(file) ? <FileStatusTip text={fileTip(file)} /> : undefined;
    if (file.status === "conflict" && onResolve) {
      const resolve = onResolve;
      return (
        <ContextMenu key={`${file.depotPath}:open`}>
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
      <HoverTip key={`${file.depotPath}:${file.shelved ? "shelf" : "open"}`} className="max-w-lg" label={tip}>
        {row}
      </HoverTip>
    );
  });
}

function fileTip(file: { depotPath: string; detail: string; action: string }) {
  return fileStatusText(file.depotPath, file.detail, file.action);
}

function actionStatus(action: string) {
  const value = action.toLowerCase();
  if (value.includes("delete")) return "delete";
  if (value.includes("add")) return "add";
  if (value.includes("edit")) return "edit";
  if (value.includes("integrate") || value.includes("move") || value.includes("branch")) return "integrate";
  return "";
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
  paths,
  onOpenChange,
  onConfirm,
}: {
  paths: string[] | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const count = paths?.length ?? 0;
  return (
    <Dialog open={paths !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revert {count === 1 ? "file" : `${count} files`}?</DialogTitle>
          <DialogDescription>
            This discards the opened changes and restores the have revision. A shelf on the server is left in place.
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
