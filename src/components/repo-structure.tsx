import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppWindowIcon,
  BoxIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FolderGit2Icon,
  InfoIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  ScissorsIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
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
import { createExclusiveAction } from "@/lib/async-scope";
import { pathsIgnoreCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { SubmoduleInfo, WorktreeInfo } from "@/types/git";

const STATE_LABEL: Record<string, string> = {
  uninitialized: "not checked out",
  modified: "moved",
  conflicted: "conflict",
};

function joinPath(root: string, relative: string) {
  return `${root.replace(pathsIgnoreCase() ? /[\\/]+$/ : /\/+$/, "")}/${relative}`;
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
  const canAddWorktree = Boolean(snapshot?.repo.headId) || Boolean(snapshot?.branches.local.some((branch) => !branch.isHead));
  const [submodules, setSubmodules] = useState<SubmoduleInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [reload, setReload] = useState(0);
  const [openSections, setOpenSections] = useState({ submodules: true, worktrees: true });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WorktreeInfo | null>(null);
  const [loadedFor, setLoadedFor] = useState("");
  const [errors, setErrors] = useState<{ submodules: string | null; worktrees: string | null }>({ submodules: null, worktrees: null });
  const [busy, setBusy] = useState(false);
  const [mutation] = useState(createExclusiveAction);
  const structureReady = loadedFor === repoPath && repoPath !== "";

  // Any repository change can move a submodule or a worktree's branch.
  useEffect(() => {
    if (!repoPath) return;
    let live = true;
    void Promise.allSettled([gitApi.listSubmodules(repoPath), gitApi.listWorktrees(repoPath)])
      .then(([modules, trees]) => {
        if (!live) return;
        if (modules.status === "fulfilled") setSubmodules(modules.value);
        if (trees.status === "fulfilled") setWorktrees(trees.value);
        setErrors({
          submodules: modules.status === "rejected" ? errorMessage(modules.reason) : null,
          worktrees: trees.status === "rejected" ? errorMessage(trees.reason) : null,
        });
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

  async function update(paths: string[]) {
    await mutation.run(async () => {
      setBusy(true);
      try { await updateSubmodules(paths); }
      finally { setBusy(false); }
    });
  }

  async function prune() {
    await mutation.run(async () => {
      setBusy(true);
      const activity = beginActivity("Pruning worktrees");
      try {
        await gitApi.pruneWorktrees(repoPath);
        setReload((value) => value + 1);
        toast.success("Pruned missing worktrees");
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        endActivity(activity);
        setBusy(false);
      }
    });
  }

  async function remove(tree: WorktreeInfo, force: boolean) {
    let removed = false;
    await mutation.run(async () => {
      setBusy(true);
      const activity = beginActivity("Removing worktree", tree.path);
      try {
        await gitApi.removeWorktree(repoPath, tree.path, force);
        setReload((value) => value + 1);
        toast.success("Removed worktree");
        removed = true;
      } finally {
        endActivity(activity);
        setBusy(false);
      }
    });
    return removed;
  }

  return (
    <>
      {structureReady && (submodules.length > 0 || errors.submodules) ? (
        <section>
          <SectionHeader
            label="Submodules"
            open={openSections.submodules}
            onToggle={() => setOpenSections((current) => ({ ...current, submodules: !current.submodules }))}
            action={
              <HoverTip label="Update all submodules">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Update all submodules"
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  disabled={busy}
                  onClick={() => void update([])}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </HoverTip>
            }
          />
          {errors.submodules ? <StructureError message={errors.submodules} busy={busy} onRetry={() => setReload((value) => value + 1)} /> : null}
          {openSections.submodules && !errors.submodules
            ? submodules.map((module) => (
                <ContextMenu key={module.path}>
                  <HoverTip label={module.url ?? module.path}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-full items-center gap-1.5 pr-2 pl-7 text-left text-xs hover:bg-muted/70"
                      onDoubleClick={() => {
                        if (module.state !== "uninitialized") void openPath(joinPath(repoPath, module.path), "git");
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
                  </HoverTip>
                  <ContextMenuContent className="w-48">
                    {module.state !== "uninitialized" ? (
                      <ContextMenuItem onClick={() => void openPath(joinPath(repoPath, module.path), "git")}>
                        <AppWindowIcon />
                        Open in a new tab
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem disabled={busy} onClick={() => void update([module.path])}>
                      {module.state === "uninitialized" ? <DownloadIcon /> : <RefreshCwIcon />}
                      {module.state === "uninitialized" ? "Check out" : "Update to recorded commit"}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {module.url ? (
                      <ContextMenuItem onClick={() => void copy(module.url ?? "")}>
                        <LinkIcon />
                        Copy URL
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem onClick={() => void copy(module.path)}>
                      <CopyIcon />
                      Copy path
                    </ContextMenuItem>
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
                  <HoverTip label={canAddWorktree ? "New worktree" : "Create a commit first"}>
                    <span className="inline-flex shrink-0" tabIndex={canAddWorktree ? undefined : 0}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="New worktree"
                        type="button"
                        className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                        disabled={busy || !canAddWorktree}
                        onClick={() => setAdding(true)}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    </span>
                  </HoverTip>
                }
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <HoverTip label={canAddWorktree ? undefined : "Create a commit first"}>
              <span className="block">
                <ContextMenuItem disabled={busy || !canAddWorktree} aria-description={canAddWorktree ? undefined : "Create a commit first"} onClick={() => setAdding(true)}>
                  <PlusIcon />
                  New worktree…
                </ContextMenuItem>
              </span>
            </HoverTip>
            <ContextMenuItem disabled={busy} onClick={() => void prune()}>
              <ScissorsIcon />
              Prune missing
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {errors.worktrees ? <StructureError message={errors.worktrees} busy={busy} onRetry={() => setReload((value) => value + 1)} /> : null}
        {openSections.worktrees && !errors.worktrees
          ? worktrees.map((tree) => (
              <ContextMenu key={tree.path}>
                <HoverTip label={tree.path}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-1.5 pr-2 pl-7 text-left text-xs hover:bg-muted/70"
                    onDoubleClick={() => {
                      if (!tree.current && !tree.prunable) void openPath(tree.path, "git");
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
                </HoverTip>
                <ContextMenuContent className="w-48">
                  {!tree.current && !tree.prunable ? (
                    <ContextMenuItem onClick={() => void openPath(tree.path, "git")}>
                      <AppWindowIcon />
                      Open in a new tab
                    </ContextMenuItem>
                  ) : null}
                  <ContextMenuItem onClick={() => void copy(tree.path)}>
                    <CopyIcon />
                    Copy path
                  </ContextMenuItem>
                  {!tree.main && !tree.current ? (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={busy} variant="destructive" onClick={() => setRemoving(tree)}>
                        <Trash2Icon />
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
          toast.success("Created worktree", { action: { label: "Open", onClick: () => void openPath(path, "git") } });
        }}
      />
      <RemoveWorktreeDialog
        tree={removing}
        onClose={() => setRemoving(null)}
        onRemove={remove}
      />
    </>
  );
}

function StructureError({ message, busy, onRetry }: { message: string; busy: boolean; onRetry: () => void }) {
  return <div role="alert" className="grid gap-1 px-3 py-2 text-xs text-destructive"><p className="break-words">{message}</p><Button variant="outline" size="xs" className="w-fit" disabled={busy} onClick={onRetry}>Retry</Button></div>;
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
  const [mutation] = useState(createExclusiveAction);
  return (
    <Dialog open={isOpen} onOpenChange={(next) => { if (!mutation.busy) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md">
        {isOpen ? <AddWorktreeForm mutation={mutation} onClose={() => onOpenChange(false)} onCreated={onCreated} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddWorktreeForm({ mutation, onClose, onCreated }: { mutation: ReturnType<typeof createExclusiveAction>; onClose: () => void; onCreated: (path: string) => void }) {
  const { snapshot } = useGitPick(["snapshot"]);
  const repoPath = snapshot?.repo.path ?? "";
  const branches = (snapshot?.branches.local ?? []).filter((branch) => !branch.isHead);
  const [folder, setFolder] = useState(() => `${repoPath.replace(/[\\/]+$/, "")}-worktree`);
  const [mode, setMode] = useState<"new" | "existing">(branches.length ? "existing" : "new");
  const [branch, setBranch] = useState(branches[0]?.name ?? "");
  const [newBranch, setNewBranch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasHead = Boolean(snapshot?.repo.headId);
  const canSave = Boolean(folder.trim()) && (mode === "existing" ? Boolean(branch) : hasHead && Boolean(newBranch.trim())) && !saving;

  async function browse() {
    const picked = await open({ directory: true, multiple: false, title: "Folder for the new worktree" });
    if (typeof picked === "string") setFolder(picked);
  }

  async function submit() {
    if (!canSave) return;
    await mutation.run(async () => {
      setSaving(true);
      setError(null);
      try {
        const path = await gitApi.addWorktree(repoPath, folder, {
          branch: mode === "existing" ? branch : undefined,
          newBranch: mode === "new" ? newBranch.trim() : undefined,
        });
        onCreated(path);
        onClose();
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        setSaving(false);
      }
    });
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
              disabled={saving}
              className="font-mono"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
            <Button type="button" variant="outline" disabled={saving} onClick={() => void browse()}>
              Browse
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex gap-1 rounded-md bg-muted p-0.5">
            {(["existing", "new"] as const).map((item) => (
              <HoverTip key={item} label={item === "new" && !hasHead ? "Create a commit first" : undefined}>
                <span className="flex flex-1" tabIndex={item === "new" && !hasHead ? 0 : undefined}>
                  <Button
                    type="button"
                    size="xs"
                    className="flex-1"
                    variant={mode === item ? "secondary" : "ghost"}
                    disabled={saving || (item === "existing" ? branches.length === 0 : !hasHead)}
                    onClick={() => setMode(item)}
                  >
                    {item === "existing" ? "Existing branch" : "New branch"}
                  </Button>
                </span>
              </HoverTip>
            ))}
          </div>
          {mode === "existing" ? (
            <select
              aria-label="Branch"
              disabled={saving}
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
              disabled={saving}
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
      {error ? <p role="alert" className="mt-3 break-words text-xs text-destructive">{error}</p> : null}
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving ? "Creating…" : "Create"}
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
  onRemove: (tree: WorktreeInfo, force: boolean) => Promise<boolean>;
}) {
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutation] = useState(createExclusiveAction);
  function close() {
    if (mutation.busy) return;
    setForce(false);
    setError(null);
    onClose();
  }
  async function submit() {
    if (!tree) return;
    await mutation.run(async () => {
      setSaving(true);
      setError(null);
      try {
        if (await onRemove(tree, force)) {
          setForce(false);
          onClose();
        }
      } catch (error) {
        setError(errorMessage(error));
      } finally { setSaving(false); }
    });
  }
  return (
    <Dialog
      open={tree !== null}
      onOpenChange={(next) => {
        if (!next) close();
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
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={force} disabled={saving} onCheckedChange={(checked) => setForce(checked === true)} />
            Force removal
          </label>
          <HoverTip label="Deletes uncommitted files and checked-out submodules in this worktree. Required when the worktree contains submodules.">
            <Button variant="ghost" size="icon-xs" aria-label="About force removal"><InfoIcon /></Button>
          </HoverTip>
        </div>
        {error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
