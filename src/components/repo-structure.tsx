import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { BoxIcon, ChevronRightIcon, FolderGit2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, gitApi } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { SubmoduleInfo, WorktreeInfo } from "@/types/git";

const STATE_LABEL: Record<string, string> = {
  uninitialized: "not checked out",
  modified: "moved",
  conflicted: "conflict",
};

function joinPath(root: string, relative: string) {
  return `${root.replace(/[\\/]+$/, "")}/${relative}`;
}

/** Submodule and worktree sections for the branches sidebar. */
export function RepoStructure({ onReady }: { onReady?: (repoPath: string) => void }) {
  const { snapshot, openPath, updateSubmodules, beginActivity, endActivity } = useGitPick([
    "snapshot",
    "openPath",
    "updateSubmodules",
    "beginActivity",
    "endActivity",
  ]);
  const repoPath = snapshot?.repo.path ?? "";
  const [submodules, setSubmodules] = useState<SubmoduleInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [reload, setReload] = useState(0);
  const [openSections, setOpenSections] = useState({ submodules: true, worktrees: true });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorktreeInfo | null>(null);
  const [loadedFor, setLoadedFor] = useState("");
  const structureReady = loadedFor === repoPath && repoPath !== "";

  // Any repository change can move a submodule or a worktree's branch.
  useEffect(() => {
    if (!repoPath) return;
    let live = true;
    void Promise.all([gitApi.listSubmodules(repoPath), gitApi.listWorktrees(repoPath)])
      .then(([modules, trees]) => {
        if (!live) return;
        setSubmodules(modules);
        setWorktrees(trees);
        setLoadedFor(repoPath);
        onReady?.(repoPath);
      })
      .catch(() => {
        if (!live) return;
        setLoadedFor(repoPath);
        onReady?.(repoPath);
      });
    return () => {
      live = false;
    };
  }, [onReady, repoPath, snapshot, reload]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  async function prune() {
    try {
      await gitApi.pruneWorktrees(repoPath);
      setReload((value) => value + 1);
      toast.success("Pruned missing worktrees");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove(tree: WorktreeInfo, force: boolean) {
    const activity = beginActivity("Removing worktree", tree.path);
    try {
      await gitApi.removeWorktree(repoPath, tree.path, force);
      setReload((value) => value + 1);
      toast.success("Removed worktree");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      endActivity(activity);
    }
  }

  return (
    <>
      {structureReady && submodules.length > 0 ? (
        <section>
          <SectionHeader
            label="Submodules"
            open={openSections.submodules}
            onToggle={() => setOpenSections((current) => ({ ...current, submodules: !current.submodules }))}
            action={
              <button
                type="button"
                title="Update all submodules"
                className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                onClick={() => void updateSubmodules([])}
              >
                <RefreshCwIcon className="size-3.5" />
              </button>
            }
          />
          {openSections.submodules
            ? submodules.map((module) => (
                <ContextMenu key={module.path}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-full items-center gap-1.5 pr-2 pl-7 text-left text-xs hover:bg-muted/70"
                      title={module.url ?? module.path}
                      onDoubleClick={() => {
                        if (module.state !== "uninitialized") void openPath(joinPath(repoPath, module.path));
                      }}
                    >
                      <BoxIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono">{module.path}</span>
                      {STATE_LABEL[module.state] ? (
                        <span
                          className={cn(
                            "shrink-0 text-[10px]",
                            module.state === "conflicted"
                              ? "text-diff-del"
                              : module.state === "modified"
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground",
                          )}
                        >
                          {STATE_LABEL[module.state]}
                        </span>
                      ) : null}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    {module.state !== "uninitialized" ? (
                      <ContextMenuItem onClick={() => void openPath(joinPath(repoPath, module.path))}>
                        Open in a new tab
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem onClick={() => void updateSubmodules([module.path])}>
                      {module.state === "uninitialized" ? "Check out" : "Update to recorded commit"}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {module.url ? (
                      <ContextMenuItem onClick={() => void copy(module.url ?? "")}>Copy URL</ContextMenuItem>
                    ) : null}
                    <ContextMenuItem onClick={() => void copy(module.path)}>Copy path</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))
            : null}
        </section>
      ) : null}
      {structureReady ? (
      <section>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div>
              <SectionHeader
                label="Worktrees"
                open={openSections.worktrees}
                onToggle={() => setOpenSections((current) => ({ ...current, worktrees: !current.worktrees }))}
                action={
                  <button
                    type="button"
                    title="New worktree"
                    className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                    onClick={() => setAdding(true)}
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                }
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem onClick={() => setAdding(true)}>New worktree…</ContextMenuItem>
            <ContextMenuItem onClick={() => void prune()}>Prune missing</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {openSections.worktrees
          ? worktrees.map((tree) => (
              <ContextMenu key={tree.path}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-1.5 pr-2 pl-7 text-left text-xs hover:bg-muted/70"
                    title={tree.path}
                    onDoubleClick={() => {
                      if (!tree.current && !tree.prunable) void openPath(tree.path);
                    }}
                  >
                    <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn("min-w-0 flex-1 truncate font-mono", tree.prunable && "line-through opacity-60")}>
                      {tree.branch ?? (tree.head ? `detached ${tree.head.slice(0, 7)}` : tree.path)}
                    </span>
                    {tree.current ? <span className="shrink-0 text-[10px] text-muted-foreground">current</span> : null}
                    {!tree.current && tree.main ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">main</span>
                    ) : null}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  {!tree.current && !tree.prunable ? (
                    <ContextMenuItem onClick={() => void openPath(tree.path)}>Open in a new tab</ContextMenuItem>
                  ) : null}
                  <ContextMenuItem onClick={() => void copy(tree.path)}>Copy path</ContextMenuItem>
                  {!tree.main && !tree.current ? (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onClick={() => setRemoving(tree)}>
                        Remove…
                      </ContextMenuItem>
                    </>
                  ) : null}
                </ContextMenuContent>
              </ContextMenu>
            ))
          : null}
      </section>
      ) : null}
      <AddWorktreeDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(path) => {
          setReload((value) => value + 1);
          toast.success("Created worktree", { action: { label: "Open", onClick: () => void openPath(path) } });
        }}
      />
      <RemoveWorktreeDialog
        tree={removing}
        onClose={() => setRemoving(null)}
        onRemove={(tree, force) => void remove(tree, force)}
      />
    </>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-1 pr-1 pl-2 text-muted-foreground hover:bg-muted/70 hover:text-foreground">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={onToggle} aria-expanded={open}>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium tracking-wide uppercase">{label}</span>
      </button>
      {action}
    </div>
  );
}

function AddWorktreeDialog({
  open: isOpen,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (path: string) => void;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {isOpen ? <AddWorktreeForm onClose={() => onOpenChange(false)} onCreated={onCreated} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddWorktreeForm({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }) {
  const { snapshot } = useGitPick(["snapshot"]);
  const repoPath = snapshot?.repo.path ?? "";
  const branches = (snapshot?.branches.local ?? []).filter((branch) => !branch.isHead);
  const [folder, setFolder] = useState(() => `${repoPath.replace(/[\\/]+$/, "")}-worktree`);
  const [mode, setMode] = useState<"new" | "existing">(branches.length ? "existing" : "new");
  const [branch, setBranch] = useState(branches[0]?.name ?? "");
  const [newBranch, setNewBranch] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave = Boolean(folder.trim()) && (mode === "existing" ? Boolean(branch) : Boolean(newBranch.trim())) && !saving;

  async function browse() {
    const picked = await open({ directory: true, multiple: false, title: "Folder for the new worktree" });
    if (typeof picked === "string") setFolder(picked);
  }

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const path = await gitApi.addWorktree(repoPath, folder.trim(), {
        branch: mode === "existing" ? branch : undefined,
        newBranch: mode === "new" ? newBranch.trim() : undefined,
      });
      onCreated(path);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New worktree</DialogTitle>
        <DialogDescription>
          Checks out another branch in its own folder, sharing this repository&apos;s history.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-3 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="worktree-folder">Folder</Label>
          <div className="flex gap-2">
            <Input
              id="worktree-folder"
              className="font-mono"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
            <Button type="button" variant="outline" onClick={() => void browse()}>
              Browse
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex gap-1 rounded-md bg-muted p-0.5">
            {(["existing", "new"] as const).map((item) => (
              <Button
                key={item}
                type="button"
                size="xs"
                className="flex-1"
                variant={mode === item ? "secondary" : "ghost"}
                disabled={item === "existing" && branches.length === 0}
                onClick={() => setMode(item)}
              >
                {item === "existing" ? "Existing branch" : "New branch"}
              </Button>
            ))}
          </div>
          {mode === "existing" ? (
            <select
              aria-label="Branch"
              className="h-8 rounded-md border bg-transparent px-2 font-mono text-sm"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
            >
              {branches.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              aria-label="New branch name"
              className="font-mono"
              placeholder="feature/name"
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
            />
          )}
          {mode === "new" ? (
            <p className="text-xs text-muted-foreground">Starts from {snapshot?.repo.currentBranch ?? "HEAD"}.</p>
          ) : null}
        </div>
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

function RemoveWorktreeDialog({
  tree,
  onClose,
  onRemove,
}: {
  tree: WorktreeInfo | null;
  onClose: () => void;
  onRemove: (tree: WorktreeInfo, force: boolean) => void;
}) {
  const [force, setForce] = useState(false);
  return (
    <Dialog
      open={tree !== null}
      onOpenChange={(next) => {
        if (!next) {
          setForce(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove worktree?</DialogTitle>
          <DialogDescription>
            Deletes the folder <span className="font-mono text-foreground">{tree?.path}</span>. Its branch
            {tree?.branch ? ` ${tree.branch}` : ""} stays in this repository.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={force} onCheckedChange={(checked) => setForce(checked === true)} />
          Remove even with uncommitted changes
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (tree) onRemove(tree, force);
              setForce(false);
              onClose();
            }}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
