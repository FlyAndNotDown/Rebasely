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
import { changeSummary, depotBase } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";

export function P4Pending() {
  const p4 = useP4();
  const selected = p4.pending.find((change) => change.id === p4.selectedChange) ?? null;
  const [creating, setCreating] = useState(false);
  const [revertPaths, setRevertPaths] = useState<string[] | null>(null);
  const numbered = p4.selectedChange !== "default";

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
        <ResizablePanel id="p4-changes" defaultSize="24%" minSize="16%" maxSize="40%">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
              <span className="text-xs font-medium text-muted-foreground">Pending</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => setCreating(true)}>
                <PlusIcon />
                New
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {p4.pending.map((change) => {
                const active = change.id === p4.selectedChange;
                const summary = changeSummary(change.description);
                return (
                  <button
                    key={change.id}
                    type="button"
                    className={cn(
                      "block w-full border-b px-3 py-2 text-left",
                      active ? "bg-muted" : "hover:bg-muted/50",
                    )}
                    onClick={() => p4.selectChange(change.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm">
                        {change.id === "default" ? "default" : `#${change.id}`}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{change.files.length}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {summary || "No description"}
                    </div>
                    {change.shelved ? (
                      <div className="mt-1 text-[10px] tracking-wide text-diff-hunk uppercase">Shelved</div>
                    ) : null}
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
                <div className="min-h-0 flex-1 overflow-auto">
                  {selected && selected.files.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">
                      No open files. Check out a file from Workspace, or reconcile offline work.
                    </p>
                  ) : (
                    selected?.files.map((file) => {
                      const active = file.depotPath === p4.selectedFile;
                      return (
                        <button
                          key={`${file.depotPath}:${file.action}`}
                          type="button"
                          className={cn(
                            "flex w-full items-center gap-2 border-b px-3 py-1.5 text-left",
                            active ? "bg-muted" : "hover:bg-muted/50",
                          )}
                          onClick={() => p4.selectFile(file.depotPath)}
                        >
                          <span className={cn("w-16 shrink-0 font-mono text-[11px]", actionClass(file.action))}>
                            {file.action}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.depotPath}>
                            {depotBase(file.depotPath)}
                          </span>
                        </button>
                      );
                    })
                  )}
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
                      disabled={!p4.description.trim() || !selected || selected.files.length === 0}
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
                      disabled={!selected || selected.files.length === 0}
                      onClick={() => setRevertPaths(selected?.files.map((file) => file.depotPath) ?? [])}
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
                              disabled={!p4.selectedFile}
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

function actionClass(action: string) {
  if (action.includes("add") || action === "branch") return "text-diff-add";
  if (action.includes("delete")) return "text-diff-del";
  return "text-diff-hunk";
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
