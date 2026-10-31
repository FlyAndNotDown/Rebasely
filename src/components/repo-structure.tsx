import { t, useTranslation } from "@/i18n";
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
  useTranslation();
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
      toast.success(t("git.ui.copied"));
    } catch {
      toast.error(t("git.ui.could_not_copy_to_the_clipboard"));
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
      const activity = beginActivity(t("git.ui.pruning_worktrees"));
      try {
        await gitApi.pruneWorktrees(repoPath);
        setReload((value) => value + 1);
        toast.success(t("git.ui.pruned_missing_worktrees"));
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
      const activity = beginActivity(t("git.ui.removing_worktree"), tree.path);
      try {
        await gitApi.removeWorktree(repoPath, tree.path, force);
        setReload((value) => value + 1);
        toast.success(t("git.ui.removed_worktree"));
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
            label={t("git.ui.submodules")}
            open={openSections.submodules}
            onToggle={() => setOpenSections((current) => ({ ...current, submodules: !current.submodules }))}
            action={
              <HoverTip label={t("git.ui.update_all_submodules")}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("git.ui.update_all_submodules")}
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
                        <AppWindowIcon />{t("git.ui.open_in_a_new_tab")}</ContextMenuItem>
                    ) : null}
                    <ContextMenuItem disabled={busy} onClick={() => void update([module.path])}>
                      {module.state === "uninitialized" ? <DownloadIcon /> : <RefreshCwIcon />}
                      {module.state === "uninitialized" ? t("git.ui.check_out") : t("git.ui.update_to_recorded_commit")}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {module.url ? (
                      <ContextMenuItem onClick={() => void copy(module.url ?? "")}>
                        <LinkIcon />{t("git.ui.copy_url")}</ContextMenuItem>
                    ) : null}
                    <ContextMenuItem onClick={() => void copy(module.path)}>
                      <CopyIcon />{t("git.ui.copy_path")}</ContextMenuItem>
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
                label={t("git.ui.worktrees")}
                open={openSections.worktrees}
                onToggle={() => setOpenSections((current) => ({ ...current, worktrees: !current.worktrees }))}
                action={
                  <HoverTip label={canAddWorktree ? t("git.ui.new_worktree") : t("git.ui.create_a_commit_first")}>
                    <span className="inline-flex shrink-0" tabIndex={canAddWorktree ? undefined : 0}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("git.ui.new_worktree")}
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
            <HoverTip label={canAddWorktree ? undefined : t("git.ui.create_a_commit_first")}>
              <span className="block">
                <ContextMenuItem disabled={busy || !canAddWorktree} aria-description={canAddWorktree ? undefined : t("git.ui.create_a_commit_first")} onClick={() => setAdding(true)}>
                  <PlusIcon />{t("git.ui.new_worktree_menu")}</ContextMenuItem>
              </span>
            </HoverTip>
            <ContextMenuItem disabled={busy} onClick={() => void prune()}>
              <ScissorsIcon />{t("git.ui.prune_missing")}</ContextMenuItem>
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
                      {tree.branch ?? (tree.head ? t("git.dynamic.detachedHead", { id: tree.head.slice(0, 7) }) : tree.path)}
                    </span>
                    {tree.current ? <span className="shrink-0 text-[10px] text-muted-foreground">{t("git.ui.current")}</span> : null}
                    {!tree.current && tree.main ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{t("git.ui.main")}</span>
                    ) : null}
                  </button>
                </ContextMenuTrigger>
                </HoverTip>
                <ContextMenuContent className="w-48">
                  {!tree.current && !tree.prunable ? (
                    <ContextMenuItem onClick={() => void openPath(tree.path, "git")}>
                      <AppWindowIcon />{t("git.ui.open_in_a_new_tab")}</ContextMenuItem>
                  ) : null}
                  <ContextMenuItem onClick={() => void copy(tree.path)}>
                    <CopyIcon />{t("git.ui.copy_path")}</ContextMenuItem>
                  {!tree.main && !tree.current ? (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={busy} variant="destructive" onClick={() => setRemoving(tree)}>
                        <Trash2Icon />{t("git.ui.remove_menu")}</ContextMenuItem>
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
          toast.success(t("git.ui.created_worktree"), { action: { label: t("git.ui.open"), onClick: () => void openPath(path, "git") } });
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
  useTranslation();
  return <div role="alert" className="grid gap-1 px-3 py-2 text-xs text-destructive"><p className="break-words">{message}</p><Button variant="outline" size="xs" className="w-fit" disabled={busy} onClick={onRetry}>{t("git.ui.retry")}</Button></div>;
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
  useTranslation();
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
  useTranslation();
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
  useTranslation();
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
    const picked = await open({ directory: true, multiple: false, title: t("git.ui.folder_for_the_new_worktree") });
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
        <DialogTitle>{t("git.ui.new_worktree")}</DialogTitle>
        <DialogDescription>
          {t("git.dynamic.worktreeDescription")}
        </DialogDescription>
      </DialogHeader>
      <div className="mt-3 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="worktree-folder">{t("git.ui.folder")}</Label>
          <div className="flex gap-2">
            <Input
              id="worktree-folder"
              disabled={saving}
              className="font-mono"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
            <Button type="button" variant="outline" disabled={saving} onClick={() => void browse()}>{t("git.ui.browse")}</Button>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex gap-1 rounded-md bg-muted p-0.5">
            {(["existing", "new"] as const).map((item) => (
              <HoverTip key={item} label={item === "new" && !hasHead ? t("git.ui.create_a_commit_first") : undefined}>
                <span className="flex flex-1" tabIndex={item === "new" && !hasHead ? 0 : undefined}>
                  <Button
                    type="button"
                    size="xs"
                    className="flex-1"
                    variant={mode === item ? "secondary" : "ghost"}
                    disabled={saving || (item === "existing" ? branches.length === 0 : !hasHead)}
                    onClick={() => setMode(item)}
                  >
                    {item === "existing" ? t("git.ui.existing_branch") : t("git.ui.new_branch")}
                  </Button>
                </span>
              </HoverTip>
            ))}
          </div>
          {mode === "existing" ? (
            <select
              aria-label={t("git.ui.branch")}
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
              aria-label={t("git.ui.new_branch_name")}
              disabled={saving}
              className="font-mono"
              placeholder={t("git.dynamic.branchExample")}
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
            />
          )}
          {mode === "new" ? (
            <p className="text-xs text-muted-foreground">{t("git.dynamic.worktreeStart", { branch: snapshot?.repo.currentBranch ?? "HEAD" })}</p>
          ) : null}
        </div>
      </div>
      {error ? <p role="alert" className="mt-3 break-words text-xs text-destructive">{error}</p> : null}
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("git.ui.cancel")}</Button>
        <Button type="submit" disabled={!canSave}>
          {saving ? t("git.ui.creating") : t("git.ui.create")}
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
  useTranslation();
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
          <DialogTitle>{t("git.ui.remove_worktree")}</DialogTitle>
          <DialogDescription>
            {t("git.dynamic.removeWorktreeDescription", { path: tree?.path, branch: tree?.branch ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={force} disabled={saving} onCheckedChange={(checked) => setForce(checked === true)} />{t("git.ui.force_removal")}</label>
          <HoverTip label={t("git.ui.deletes_uncommitted_files_and_checked_out_submodules_in_this_worktree_required_when_the_worktree_contains_submodules")}>
            <Button variant="ghost" size="icon-xs" aria-label={t("git.ui.about_force_removal")}><InfoIcon /></Button>
          </HoverTip>
        </div>
        {error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>{t("git.ui.cancel")}</Button>
          <Button
            variant="destructive"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? t("git.ui.removing") : t("git.ui.remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
