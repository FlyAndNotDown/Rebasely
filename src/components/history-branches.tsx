import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRightIcon, ChevronRightIcon, EyeIcon, GitBranchIcon, PlusIcon, SearchIcon, TagIcon } from "lucide-react";
import { AddRemoteDialog } from "@/components/lazy-dialogs";
import { CreateTagDialog } from "@/components/create-ref-dialogs";
import { MergeDialog, RebaseOntoDialog } from "@/components/rebase-dialog";
import { RepoStructure } from "@/components/repo-structure";
import { BranchSidebarSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { groupRemoteBranches, shortRemoteName } from "@/lib/branches";
import { isRemoteTrackingBranch } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { BranchInfo } from "@/types/git";

type BranchTreeNode = {
  id: string;
  label: string;
  branch?: BranchInfo;
  tag?: string;
  children: BranchTreeNode[];
};

const DEFAULT_EXPANDED = ["section:local", "section:remotes", "remote:origin", "section:tags"];

export function HistoryBranches() {
  const {
    snapshot,
    historyRevs,
    setHistoryRevs,
    historyExpanded,
    setHistoryExpanded,
    ensureBranches,
    addRemote,
    deleteRemote,
    checkoutBranch,
    deleteBranch,
    fetchRemote,
    deleteTag,
    deleteRemoteTag,
    pushTag,
    openComparison,
  } = useGitPick([
    "snapshot",
    "historyRevs",
    "setHistoryRevs",
    "historyExpanded",
    "setHistoryExpanded",
    "ensureBranches",
    "addRemote",
    "deleteRemote",
    "checkoutBranch",
    "deleteBranch",
    "fetchRemote",
    "deleteTag",
    "deleteRemoteTag",
    "pushTag",
    "openComparison",
  ]);
  const [tagRemotes, setTagRemotes] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<BranchInfo | null>(null);
  const [forceDeleting, setForceDeleting] = useState<BranchInfo | null>(null);
  const [trackedDelete, setTrackedDelete] = useState<BranchInfo | null>(null);
  const [deleteRemoteToo, setDeleteRemoteToo] = useState(true);
  const [pendingRemote, setPendingRemote] = useState<string | null>(null);
  const [deletingRemote, setDeletingRemote] = useState<string | null>(null);
  const [rebasing, setRebasing] = useState<BranchInfo | null>(null);
  const [merging, setMerging] = useState<BranchInfo | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [deletingMany, setDeletingMany] = useState<BranchInfo[] | null>(null);
  const [branchesReadyFor, setBranchesReadyFor] = useState("");
  const [structureReadyFor, setStructureReadyFor] = useState("");
  const branchAnchor = useRef<string | null>(null);
  const canRebase =
    Boolean(snapshot?.repo.currentBranch) && !snapshot?.repo.isDetached && !snapshot?.repo.operation;
  const branches = snapshot?.branches;
  const repoPath = snapshot?.repo.path ?? "";
  // Local branches arrive with the snapshot. Remotes, tags, and worktrees each
  // finish later, so the column stays a skeleton until that whole set is in.
  const sidebarReady =
    repoPath !== "" && branchesReadyFor === repoPath && structureReadyFor === repoPath;
  const watched = useMemo(() => new Set(historyRevs), [historyRevs]);
  const expanded = useMemo(
    () => new Set(historyExpanded ?? DEFAULT_EXPANDED),
    [historyExpanded],
  );

  useEffect(() => {
    if (!repoPath) return;
    let live = true;
    void ensureBranches().finally(() => {
      if (live) setBranchesReadyFor(repoPath);
    });
    return () => {
      live = false;
    };
  }, [ensureBranches, branches?.remote.length, repoPath]);

  useEffect(() => {
    if (historyExpanded !== null) return;
    const ids = new Set(DEFAULT_EXPANDED);
    const current = branches?.current;
    if (current) {
      for (const id of folderIdsForPath("local", current.split("/"))) ids.add(id);
      const upstream = branches?.local.find((branch) => branch.name === current)?.upstream;
      if (upstream) ids.add(`remote:${upstream.split("/")[0]}`);
    }
    setHistoryExpanded([...ids]);
  }, [branches, historyExpanded, setHistoryExpanded]);

  const localTree = useMemo(() => {
    const items = branches?.local ?? [];
    const filtered = needle
      ? items.filter((branch) => branch.name.toLowerCase().includes(needle))
      : items;
    return buildBranchTree(filtered, (branch) => branch.name.split("/"), "local");
  }, [branches?.local, needle]);

  const remotes = useMemo(() => {
    const remoteNames = snapshot?.remotes.map((remote) => remote.name) ?? [];
    const items = (branches?.remote ?? []).filter((branch) =>
      isRemoteTrackingBranch(branch.name, remoteNames),
    );
    const filtered = needle
      ? items.filter((branch) => branch.name.toLowerCase().includes(needle))
      : items;
    return groupRemoteBranches(filtered, needle ? [] : remoteNames).map(([remote, list]) => ({
      remote,
      tree: buildBranchTree(
        list,
        (branch) => shortRemoteName(branch.name, remote).split("/"),
        `remote:${remote}`,
      ),
    }));
  }, [branches?.remote, needle, snapshot?.remotes]);

  const tagTree = useMemo(() => {
    const items = (branches?.tags ?? []).filter(
      (tag) => !needle || tag.name.toLowerCase().includes(needle),
    );
    return markTagNodes(
      buildBranchTree(
        items.map((tag) => ({ name: tag.name, isHead: false, isRemote: false, upstream: null })),
        (tag) => tag.name.split("/"),
        "tag",
      ),
    );
  }, [branches?.tags, needle]);

  function toggleFolder(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHistoryExpanded([...next]);
  }

  function selectBranches(name: string, mode: "single" | "toggle" | "range") {
    if (mode === "toggle") {
      setSelectedNames((current) =>
        current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
      );
      branchAnchor.current = name;
      return;
    }
    if (mode === "range" && branchAnchor.current) {
      const names = visibleBranches.map((branch) => branch.name);
      const start = names.indexOf(branchAnchor.current);
      const end = names.indexOf(name);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setSelectedNames(names.slice(from, to + 1));
        return;
      }
    }
    setSelectedNames([name]);
    branchAnchor.current = name;
  }

  function toggleWatch(name: string) {
    if (watched.has(name)) {
      setHistoryRevs(historyRevs.filter((rev) => rev !== name));
      return;
    }
    setHistoryRevs([...historyRevs, name]);
  }

  async function removeLocalBranch(branch: BranchInfo, force: boolean, remote: string | null) {
    const result = await deleteBranch(branch.name, force);
    if (result === "unmerged") {
      setPendingRemote(remote);
      setForceDeleting(branch);
      return;
    }
    if (result === true && remote) await deleteBranch(remote);
  }

  async function deleteMany(branches: BranchInfo[]) {
    for (const branch of branches) {
      if (branch.isHead) continue;
      const result = await deleteBranch(branch.name);
      if (result === "unmerged") {
        setPendingRemote(null);
        setForceDeleting(branch);
        return;
      }
      if (result !== true) return;
    }
    setSelectedNames([]);
  }

  function requestDelete(branch: BranchInfo) {
    if (branch.isHead) return;
    if (branch.isRemote) {
      setDeleting(branch);
      return;
    }
    if (branch.upstream) {
      setDeleteRemoteToo(true);
      setTrackedDelete(branch);
      return;
    }
    void removeLocalBranch(branch, false, null);
  }

  async function handleAddRemote(name: string, url: string) {
    const ok = await addRemote(name, url);
    if (ok) {
      const next = new Set(expanded);
      next.add("section:remotes");
      next.add(`remote:${name}`);
      setHistoryExpanded([...next]);
    }
    return ok;
  }

  const forceOpen = Boolean(needle);
  const remotesTree = remotes
    .filter((group) => !needle || group.tree.length > 0)
    .map(({ remote, tree }) => ({
      id: `remote:${remote}`,
      label: remote,
      children: tree,
    }));
  const root: BranchTreeNode[] = [
    ...(localTree.length > 0
      ? [{ id: "section:local", label: "Local", children: localTree }]
      : []),
    ...(!needle || remotesTree.length > 0
      ? [{ id: "section:remotes", label: "Remotes", children: remotesTree }]
      : []),
    ...(!needle || tagTree.length > 0
      ? [{ id: "section:tags", label: "Tags", children: tagTree }]
      : []),
  ];
  const visibleBranches = collectBranches(root, expanded, forceOpen);
  const allBranches = collectAllBranches(root);

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      aria-busy={!sidebarReady}
    >
      <div className="shrink-0 border-b px-2 py-1.5">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setNeedle(query.trim().toLowerCase());
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
                setNeedle("");
              }
            }}
            placeholder="Filter branches and tags"
            className="h-7 pl-7"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 py-1">
        {sidebarReady ? null : <BranchSidebarSkeleton />}
        {sidebarReady && root.length === 0 && needle ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matching branches
          </div>
        ) : null}
        {sidebarReady && (root.length > 0 || !needle) ? (
          <TreeRows
            nodes={root}
            depth={0}
            expanded={expanded}
            forceOpen={forceOpen}
            watched={watched}
            onToggleFolder={toggleFolder}
            onToggleWatch={toggleWatch}
            onCheckout={(branch) => void checkoutBranch(branch.name)}
            onDelete={requestDelete}
            onRebase={canRebase ? setRebasing : undefined}
            onMerge={canRebase ? setMerging : undefined}
            onDeleteRemote={setDeletingRemote}
            onFetchRemote={(name) => void fetchRemote(name)}
            onAddRemote={() => setAddOpen(true)}
            onCreateTag={() => setCreatingTag(true)}
            onDeleteTag={setDeletingTag}
            onPushTag={(remote, name) => void pushTag(remote, name)}
            remotes={snapshot?.remotes.map((remote) => remote.name) ?? []}
            selectedNames={selectedNames}
            selectedBranches={selectedNames
              .map((name) => visibleBranches.find((branch) => branch.name === name) ?? allBranches.find((branch) => branch.name === name))
              .filter((branch): branch is BranchInfo => Boolean(branch))}
            onSelectBranch={selectBranches}
            onCompareBranches={(branches) => {
              const [base, head] = branches;
              if (!base || !head) return;
              openComparison({ rev: base.name, label: base.name }, { rev: head.name, label: head.name });
            }}
            onShowBranches={(names) => {
              const next = new Set(historyRevs);
              for (const name of names) next.add(name);
              setHistoryRevs([...next]);
            }}
            onHideBranches={(names) => {
              const hide = new Set(names);
              setHistoryRevs(historyRevs.filter((rev) => !hide.has(rev)));
            }}
            onDeleteBranches={setDeletingMany}
          />
        ) : null}
        <div className={cn((!sidebarReady || Boolean(needle)) && "hidden")}>
          <RepoStructure onReady={setStructureReadyFor} />
        </div>
      </ScrollArea>
      <MergeDialog
        target={merging ? { onto: merging.name, label: merging.name } : null}
        onOpenChange={(open) => {
          if (!open) setMerging(null);
        }}
      />
      <RebaseOntoDialog
        target={rebasing ? { onto: rebasing.name, label: rebasing.name } : null}
        onOpenChange={(open) => {
          if (!open) setRebasing(null);
        }}
      />
      <AddRemoteDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingNames={snapshot?.remotes.map((remote) => remote.name) ?? []}
        onAdd={handleAddRemote}
      />
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete remote branch?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-mono text-foreground">{deleting?.name}</span> from the remote.
              Anyone still using it will need to recover the branch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const branch = deleting;
                if (!branch) return;
                setDeleting(null);
                void deleteBranch(branch.name);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(trackedDelete)}
        onOpenChange={(open) => {
          if (!open) setTrackedDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete branch?</DialogTitle>
            <DialogDescription>
              Delete local branch{" "}
              <span className="font-mono text-foreground">{trackedDelete?.name}</span>.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={deleteRemoteToo}
              onCheckedChange={(value) => setDeleteRemoteToo(value === true)}
            />
            <span>
              Also delete remote branch{" "}
              <span className="font-mono">{trackedDelete?.upstream}</span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTrackedDelete(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const branch = trackedDelete;
                if (!branch) return;
                const remote = deleteRemoteToo ? branch.upstream : null;
                setTrackedDelete(null);
                void removeLocalBranch(branch, false, remote);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(forceDeleting)}
        onOpenChange={(open) => {
          if (!open) {
            setForceDeleting(null);
            setPendingRemote(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete unmerged branch?</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-foreground">{forceDeleting?.name}</span> is not fully
              merged into the current branch. Deleting it drops commits that exist only on this
              branch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setForceDeleting(null);
                setPendingRemote(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const branch = forceDeleting;
                const remote = pendingRemote;
                if (!branch) return;
                setForceDeleting(null);
                setPendingRemote(null);
                void removeLocalBranch(branch, true, remote);
              }}
            >
              Delete anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CreateTagDialog open={creatingTag} onOpenChange={setCreatingTag} />
      <Dialog
        open={Boolean(deletingTag)}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingTag(null);
            setTagRemotes([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete tag?</DialogTitle>
            <DialogDescription>
              This deletes the local tag <span className="font-mono text-foreground">{deletingTag}</span>
              {tagRemotes.length ? ` and the tag on ${tagRemotes.join(", ")}.` : ". Remote tags are left in place."}
            </DialogDescription>
          </DialogHeader>
          {snapshot?.remotes.length ? (
            <div className="grid gap-2">
              {snapshot.remotes.map((remote) => (
                <label key={remote.name} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={tagRemotes.includes(remote.name)}
                    onCheckedChange={(checked) =>
                      setTagRemotes((current) =>
                        checked === true
                          ? [...current, remote.name]
                          : current.filter((name) => name !== remote.name),
                      )
                    }
                  />
                  Also delete from <span className="font-mono">{remote.name}</span>
                </label>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDeletingTag(null);
                setTagRemotes([]);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const name = deletingTag;
                const remotes = tagRemotes;
                if (!name) return;
                setDeletingTag(null);
                setTagRemotes([]);
                void (async () => {
                  if (!(await deleteTag(name))) return;
                  for (const remote of remotes) await deleteRemoteTag(remote, name);
                })();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(deletingMany)} onOpenChange={(open) => !open && setDeletingMany(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deletingMany?.length === 1 ? "this branch?" : `${deletingMany?.length ?? 0} branches?`}
            </DialogTitle>
            <DialogDescription>
              {deletingMany?.some((branch) => !branch.isRemote && branch.upstream)
                ? "Remote branches that track these are left in place."
                : "This cannot be undone from the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            {deletingMany?.map((branch) => (
              <div key={branch.name} className="truncate font-mono text-xs">
                {branch.name}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingMany(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const branches = deletingMany;
                if (!branches) return;
                setDeletingMany(null);
                void deleteMany(branches);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(deletingRemote)} onOpenChange={(open) => !open && setDeletingRemote(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete remote?</DialogTitle>
            <DialogDescription>
              This removes{" "}
              <span className="font-mono text-foreground">{deletingRemote}</span> and its
              remote-tracking branches from this repository.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingRemote(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const name = deletingRemote;
                if (!name) return;
                setDeletingRemote(null);
                void deleteRemote(name);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TreeRows({
  nodes,
  depth,
  expanded,
  forceOpen,
  watched,
  onToggleFolder,
  onToggleWatch,
  onCheckout,
  onDelete,
  onRebase,
  onMerge,
  onDeleteRemote,
  onFetchRemote,
  onAddRemote,
  onCreateTag,
  onDeleteTag,
  onPushTag,
  remotes,
  selectedNames,
  selectedBranches,
  onSelectBranch,
  onCompareBranches,
  onShowBranches,
  onHideBranches,
  onDeleteBranches,
}: {
  nodes: BranchTreeNode[];
  depth: number;
  expanded: Set<string>;
  forceOpen: boolean;
  watched: Set<string>;
  onToggleFolder: (id: string) => void;
  onToggleWatch: (name: string) => void;
  onCheckout: (branch: BranchInfo) => void;
  onDelete: (branch: BranchInfo) => void;
  onRebase?: (branch: BranchInfo) => void;
  onMerge?: (branch: BranchInfo) => void;
  onDeleteRemote?: (name: string) => void;
  onFetchRemote?: (name: string) => void;
  onAddRemote?: () => void;
  onCreateTag?: () => void;
  onDeleteTag?: (name: string) => void;
  onPushTag?: (remote: string, name: string) => void;
  remotes?: string[];
  selectedNames?: string[];
  selectedBranches?: BranchInfo[];
  onSelectBranch?: (name: string, mode: "single" | "toggle" | "range") => void;
  onCompareBranches?: (branches: BranchInfo[]) => void;
  onShowBranches?: (names: string[]) => void;
  onHideBranches?: (names: string[]) => void;
  onDeleteBranches?: (branches: BranchInfo[]) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.tag) {
          const name = node.tag;
          const active = watched.has(name);
          return (
            <ContextMenu key={node.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Tag ${name}`}
                  className="flex h-7 items-center gap-1 pr-1 text-muted-foreground outline-none hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring"
                  style={{ paddingLeft: 8 + depth * 12 }}
                >
                  <TagIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.label}</span>
                  <WatchButton
                    active={active}
                    title={active ? "Remove this tag from History" : "Add this tag to History"}
                    onClick={() => onToggleWatch(name)}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <ContextMenuItem onClick={() => onCheckout({ name, isHead: false, isRemote: false, upstream: null })}>
                  Checkout
                </ContextMenuItem>
                {onPushTag && remotes && remotes.length > 0 ? (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>Push to</ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {remotes.map((remote) => (
                        <ContextMenuItem key={remote} onClick={() => onPushTag(remote, name)}>
                          <span className="font-mono">{remote}</span>
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ) : null}
                {onDeleteTag ? (
                  <ContextMenuItem variant="destructive" onClick={() => onDeleteTag(name)}>
                    Delete
                  </ContextMenuItem>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
          );
        }
        if (node.branch) {
          const branch = node.branch;
          const active = watched.has(branch.name);
          const picked =
            selectedNames?.includes(branch.name) && (selectedBranches?.length ?? 0) > 1
              ? selectedBranches ?? null
              : null;
          return (
            <ContextMenu key={node.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={Boolean(selectedNames?.includes(branch.name))}
                  aria-label={`Branch ${branch.name}`}
                  className={cn(
                    "flex h-7 items-center gap-1 pr-1 text-muted-foreground outline-none hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring",
                    selectedNames?.includes(branch.name) && "bg-muted text-foreground",
                  )}
                  style={{ paddingLeft: 8 + depth * 12 }}
                  onClick={(event) =>
                    onSelectBranch?.(
                      branch.name,
                      event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single",
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelectBranch?.(
                      branch.name,
                      event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "single",
                    );
                  }}
                  onContextMenu={() => {
                    if (!selectedNames?.includes(branch.name)) onSelectBranch?.(branch.name, "single");
                  }}
                >
                  <GitBranchIcon
                    className={cn(
                      "size-3.5 shrink-0",
                      branch.isHead ? "text-foreground" : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono text-xs",
                      branch.isHead ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {node.label}
                  </span>
                  <WatchButton
                    active={active}
                    title={active ? "Remove this branch from History" : "Add this branch to History"}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleWatch(branch.name);
                    }}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                {picked && onCompareBranches && onShowBranches && onHideBranches && onDeleteBranches ? (
                  <MultiBranchMenu
                    branches={picked}
                    watched={watched}
                    onCompare={onCompareBranches}
                    onShow={onShowBranches}
                    onHide={onHideBranches}
                    onDelete={onDeleteBranches}
                  />
                ) : (
                <>
                <ContextMenuItem disabled={branch.isHead} onClick={() => onCheckout(branch)}>
                  Checkout
                </ContextMenuItem>
                {onRebase ? (
                  <ContextMenuItem disabled={branch.isHead} onClick={() => onRebase(branch)}>
                    Rebase onto
                  </ContextMenuItem>
                ) : null}
                {onMerge ? (
                  <ContextMenuItem disabled={branch.isHead} onClick={() => onMerge(branch)}>
                    Merge
                  </ContextMenuItem>
                ) : null}
                <ContextMenuItem
                  variant="destructive"
                  disabled={branch.isHead}
                  onClick={() => onDelete(branch)}
                >
                  Delete
                </ContextMenuItem>
                </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        }
        const open = forceOpen || expanded.has(node.id);
        const section = depth === 0;
        const remoteSection = node.id === "section:remotes";
        const tags = node.id === "section:tags";
        const remoteName = remoteFolderName(node.id);
        const folderRow = (
          <div
            className="flex h-7 items-center gap-1 pr-1 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 text-left"
              onClick={() => onToggleFolder(node.id)}
            >
              <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  section
                    ? "text-[10px] font-medium tracking-wide uppercase"
                    : "font-mono text-xs",
                )}
              >
                {node.label}
              </span>
            </button>
            {remoteSection && onAddRemote ? (
              <HoverTip label="Add remote">
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  onClick={onAddRemote}
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </HoverTip>
            ) : null}
            {tags && onCreateTag ? (
              <HoverTip label="Create tag">
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  onClick={onCreateTag}
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </HoverTip>
            ) : null}
          </div>
        );
        return (
          <div key={node.id}>
            {remoteName && (onFetchRemote || onDeleteRemote) ? (
              <ContextMenu>
                <ContextMenuTrigger asChild>{folderRow}</ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                  {onFetchRemote ? (
                    <ContextMenuItem onClick={() => onFetchRemote(remoteName)}>Fetch</ContextMenuItem>
                  ) : null}
                  {onDeleteRemote ? (
                    <ContextMenuItem variant="destructive" onClick={() => onDeleteRemote(remoteName)}>
                      Delete
                    </ContextMenuItem>
                  ) : null}
                </ContextMenuContent>
              </ContextMenu>
            ) : (
              folderRow
            )}
            {open ? (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                forceOpen={forceOpen}
                watched={watched}
                onToggleFolder={onToggleFolder}
                onToggleWatch={onToggleWatch}
                onCheckout={onCheckout}
                onDelete={onDelete}
                onRebase={onRebase}
                onMerge={onMerge}
                onDeleteRemote={onDeleteRemote}
                onFetchRemote={onFetchRemote}
                onAddRemote={onAddRemote}
                onCreateTag={onCreateTag}
                onDeleteTag={onDeleteTag}
                onPushTag={onPushTag}
                remotes={remotes}
                selectedNames={selectedNames}
                selectedBranches={selectedBranches}
                onSelectBranch={onSelectBranch}
                onCompareBranches={onCompareBranches}
                onShowBranches={onShowBranches}
                onHideBranches={onHideBranches}
                onDeleteBranches={onDeleteBranches}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function MultiBranchMenu({
  branches,
  watched,
  onCompare,
  onShow,
  onHide,
  onDelete,
}: {
  branches: BranchInfo[];
  watched: Set<string>;
  onCompare: (branches: BranchInfo[]) => void;
  onShow: (names: string[]) => void;
  onHide: (names: string[]) => void;
  onDelete: (branches: BranchInfo[]) => void;
}) {
  const names = branches.map((branch) => branch.name);
  const hidden = names.filter((name) => !watched.has(name));
  const shown = names.filter((name) => watched.has(name));
  const deletable = branches.filter((branch) => !branch.isHead);
  return (
    <>
      {branches.length === 2 ? (
        <ContextMenuItem onClick={() => onCompare(branches)}>
          <ArrowLeftRightIcon />
          Compare
        </ContextMenuItem>
      ) : null}
      {hidden.length > 0 ? (
        <ContextMenuItem onClick={() => onShow(hidden)}>
          <EyeIcon />
          Show in history
        </ContextMenuItem>
      ) : null}
      {shown.length > 0 ? (
        <ContextMenuItem onClick={() => onHide(shown)}>
          <EyeIcon />
          Hide from history
        </ContextMenuItem>
      ) : null}
      {deletable.length > 0 ? (
        <ContextMenuItem variant="destructive" onClick={() => onDelete(deletable)}>
          Delete
        </ContextMenuItem>
      ) : null}
    </>
  );
}

function collectBranches(nodes: BranchTreeNode[], expanded: Set<string>, forceOpen: boolean): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const node of nodes) {
    if (node.branch) branches.push(node.branch);
    const folder = !node.branch && !node.tag;
    if (!folder || forceOpen || expanded.has(node.id)) {
      branches.push(...collectBranches(node.children, expanded, forceOpen));
    }
  }
  return branches;
}

function collectAllBranches(nodes: BranchTreeNode[]): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const node of nodes) {
    if (node.branch) branches.push(node.branch);
    branches.push(...collectAllBranches(node.children));
  }
  return branches;
}

function WatchButton({
  active,
  title,
  onClick,
}: {
  active: boolean;
  title: string;
  onClick: (event: { stopPropagation: () => void }) => void;
}) {
  return (
    <HoverTip label={title}>
    <button
      type="button"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted",
        active ? "text-foreground" : "text-muted-foreground/45 hover:text-muted-foreground",
      )}
      onClick={onClick}
    >
      <EyeIcon className="size-3.5" />
    </button>
    </HoverTip>
  );
}

function markTagNodes(nodes: BranchTreeNode[]): BranchTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    tag: node.branch?.name,
    branch: undefined,
    children: markTagNodes(node.children),
  }));
}

function buildBranchTree(
  branches: BranchInfo[],
  segmentsOf: (branch: BranchInfo) => string[],
  prefix: string,
): BranchTreeNode[] {
  const root: Folder = { folders: new Map(), branches: [] };
  for (const branch of branches) {
    const segments = segmentsOf(branch).filter(Boolean);
    if (segments.length === 0) continue;
    insertFolder(root, segments, branch);
  }
  return folderToNodes(root, prefix);
}

type Folder = {
  folders: Map<string, Folder>;
  branches: BranchInfo[];
};

function insertFolder(node: Folder, segments: string[], branch: BranchInfo) {
  if (segments.length === 1) {
    node.branches.push(branch);
    return;
  }
  const [head, ...rest] = segments;
  let child = node.folders.get(head);
  if (!child) {
    child = { folders: new Map(), branches: [] };
    node.folders.set(head, child);
  }
  insertFolder(child, rest, branch);
}

function folderToNodes(folder: Folder, prefix: string): BranchTreeNode[] {
  const nodes: BranchTreeNode[] = [];
  const folderNames = [...folder.folders.keys()].sort((left, right) => left.localeCompare(right));
  for (const name of folderNames) {
    const id = `${prefix}/${name}`;
    nodes.push({
      id,
      label: name,
      children: folderToNodes(folder.folders.get(name)!, id),
    });
  }
  const leaves = [...folder.branches].sort((left, right) => left.name.localeCompare(right.name));
  for (const branch of leaves) {
    const label = branch.name.split("/").pop() ?? branch.name;
    nodes.push({
      id: `${prefix}:${branch.name}`,
      label,
      branch,
      children: [],
    });
  }
  return nodes;
}

function folderIdsForPath(prefix: string, segments: string[]) {
  const ids: string[] = [];
  let current = prefix;
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    ids.push(current);
  }
  return ids;
}

function remoteFolderName(id: string) {
  if (!id.startsWith("remote:") || id.includes("/")) return null;
  return id.slice("remote:".length);
}

