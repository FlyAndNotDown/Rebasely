import { useState } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { changeSummary, depotBase, p4ActionClass, p4ActionLetter } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";

export function P4Pending() {
  const p4 = useP4();
  const selected = p4.pending.find((change) => change.id === p4.selectedChange) ?? null;
  const opened = selected?.files.filter((file) => !file.shelved) ?? [];
  const shelved = selected?.files.filter((file) => file.shelved) ?? [];
  const [creating, setCreating] = useState(false);
  const [groups, setGroups] = useState({ changes: true, shelved: true });
  const [revertPaths, setRevertPaths] = useState<string[] | null>(null);
  const numbered = p4.selectedChange !== "default";

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
        <ResizablePanel id="p4-changes" defaultSize="24%" minSize="16%" maxSize="40%">
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
                const active = change.id === p4.selectedChange;
                const summary = changeSummary(change.description);
                const openedCount = change.files.filter((file) => !file.shelved).length;
                const shelvedCount = change.files.filter((file) => file.shelved).length;
                return (
                  <button
                    key={change.id}
                    type="button"
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/70",
                      active && "bg-muted",
                    )}
                    onClick={() => p4.selectChange(change.id)}
                  >
                    <span className="w-16 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                      {change.id === "default" ? "default" : `#${change.id}`}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">{summary || "No description"}</span>
                    <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground" title="Changes">
                      {openedCount}
                    </span>
                    <span
                      className={cn(
                        "w-8 shrink-0 text-right text-[11px] tabular-nums",
                        shelvedCount > 0 ? "text-diff-hunk" : "text-muted-foreground",
                      )}
                      title="Shelved"
                    >
                      {shelvedCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="p4-pending-main" defaultSize="76%" minSize="40%">
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0">
            <ResizablePanel id="p4-files" defaultSize="38%" minSize="24%" maxSize="55%">
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
                  <FileGroup
                    title="Changes"
                    open={groups.changes}
                    files={opened}
                    selectedPath={p4.selectedFile}
                    selectedShelved={p4.selectedShelved}
                    onToggle={() => setGroups((current) => ({ ...current, changes: !current.changes }))}
                    onSelect={(path) => p4.selectFile(path, false)}
                  />
                  <FileGroup
                    title="Shelved"
                    open={groups.shelved}
                    files={shelved}
                    selectedPath={p4.selectedFile}
                    selectedShelved={p4.selectedShelved}
                    onToggle={() => setGroups((current) => ({ ...current, shelved: !current.shelved }))}
                    onSelect={(path) => p4.selectFile(path, true)}
                  />
                  {opened.length === 0 && shelved.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">
                      No open files. Check out a file from Workspace, or reconcile offline work.
                    </p>
                  ) : null}
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
                      disabled={!numbered}
                      title={numbered ? "Shelve on the server" : "Save as a numbered changelist before shelving"}
                      onClick={() => void p4.shelveSelected()}
                    >
                      Shelve
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" size="sm" variant="ghost">
                          More
                          <ChevronDownIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          disabled={!p4.description.trim()}
                          onClick={() => void p4.saveSelected()}
                        >
                          {numbered ? "Save description" : "Move to new changelist"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!selected?.shelved}
                          onClick={() => void p4.unshelveSelected()}
                        >
                          Unshelve
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!selected?.shelved}
                          onClick={() => void p4.deleteSelectedShelf()}
                        >
                          Delete shelf
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void p4.revertUnchanged()}>
                          Revert unchanged files
                        </DropdownMenuItem>
                        {p4.pending
                          .filter((change) => change.id !== p4.selectedChange)
                          .map((change) => (
                            <DropdownMenuItem
                              key={change.id}
                              disabled={!p4.selectedFile || p4.selectedShelved}
                              onClick={() =>
                                p4.selectedFile && void p4.moveFiles([p4.selectedFile], change.id)
                              }
                            >
                              Move file to {change.id === "default" ? "default" : `#${change.id}`}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="p4-diff" defaultSize="62%" minSize="30%">
              <P4Diff
                diff={p4.diff}
                loading={p4.diffLoading}
                empty={p4.selectedFile ? "Loading diff" : "Select a file to see its diff"}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
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
    </>
  );
}

function FileGroup({
  title,
  open,
  files,
  selectedPath,
  selectedShelved,
  onToggle,
  onSelect,
}: {
  title: string;
  open: boolean;
  files: { depotPath: string; action: string; shelved: boolean }[];
  selectedPath: string | null;
  selectedShelved: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left hover:bg-muted/70"
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronDownIcon className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <span className="text-xs font-medium">{title}</span>
        <span className="tabular-nums text-xs text-muted-foreground">{files.length}</span>
      </button>
      {open
        ? files.map((file) => {
            const active = file.depotPath === selectedPath && file.shelved === selectedShelved;
            return (
              <button
                key={`${file.depotPath}:${file.shelved ? "shelf" : "open"}`}
                type="button"
                title={file.action}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
                  active && "bg-muted",
                )}
                onClick={() => onSelect(file.depotPath)}
              >
                <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-medium", p4ActionClass(file.action))}>
                  {p4ActionLetter(file.action)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono" title={file.depotPath}>
                  {depotBase(file.depotPath)}
                </span>
              </button>
            );
          })
        : null}
    </div>
  );
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
