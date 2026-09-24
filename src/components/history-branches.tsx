import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, EyeIcon, GitBranchIcon, PlusIcon, SearchIcon } from "lucide-react";
import { AddRemoteDialog } from "@/components/add-remote-dialog";
import { MergeDialog, RebaseOntoDialog } from "@/components/rebase-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import { isRemoteTrackingBranch } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { BranchInfo } from "@/types/git";

type BranchTreeNode = {
  id: string;
  label: string;
  branch?: BranchInfo;
  children: BranchTreeNode[];
};

const DEFAULT_EXPANDED = ["section:local", "section:remotes", "remote:origin"];

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
  } = useGit();
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<BranchInfo | null>(null);
  const [deletingRemote, setDeletingRemote] = useState<string | null>(null);
  const [rebasing, setRebasing] = useState<BranchInfo | null>(null);
  const [merging, setMerging] = useState<BranchInfo | null>(null);
  const canRebase =
    Boolean(snapshot?.repo.currentBranch) && !snapshot?.repo.isDetached && !snapshot?.repo.operation;
  const branches = snapshot?.branches;
  const watched = useMemo(() => new Set(historyRevs), [historyRevs]);
  const expanded = useMemo(
    () => new Set(historyExpanded ?? DEFAULT_EXPANDED),
    [historyExpanded],
  );

  useEffect(() => {
    void ensureBranches();
  }, [ensureBranches, branches?.remote.length]);

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
  }, [branches?.current, historyExpanded, setHistoryExpanded]);

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

  function toggleFolder(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHistoryExpanded([...next]);
  }

  function toggleWatch(name: string) {
    if (watched.has(name)) {
      setHistoryRevs(historyRevs.filter((rev) => rev !== name));
      return;
    }
    setHistoryRevs([...historyRevs, name]);
  }

  function requestDelete(branch: BranchInfo) {
    if (branch.isHead) return;
    if (branch.isRemote) {
      setDeleting(branch);
      return;
    }
    void deleteBranch(branch.name);
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
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
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
            placeholder="Filter branches"
            className="h-7 pl-7"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 py-1">
        {root.length === 0 && needle ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matching branches
          </div>
        ) : (
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
          />
        )}
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
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.branch) {
          const branch = node.branch;
          const active = watched.has(branch.name);
          return (
            <ContextMenu key={node.id}>
              <ContextMenuTrigger asChild>
                <div
                  className="flex h-7 items-center gap-1 pr-1 text-muted-foreground hover:bg-muted/70"
                  style={{ paddingLeft: 8 + depth * 12 }}
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
                    onClick={() => onToggleWatch(branch.name)}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
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
              </ContextMenuContent>
            </ContextMenu>
          );
        }
        const open = forceOpen || expanded.has(node.id);
        const section = depth === 0;
        const remotes = node.id === "section:remotes";
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
            {remotes && onAddRemote ? (
              <button
                type="button"
                title="Add remote"
                className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                onClick={onAddRemote}
              >
                <PlusIcon className="size-3.5" />
              </button>
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
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function WatchButton({
  active,
  title,
  onClick,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted",
        active ? "text-foreground" : "text-muted-foreground/45 hover:text-muted-foreground",
      )}
      onClick={onClick}
    >
      <EyeIcon className="size-3.5" />
    </button>
  );
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

function groupRemoteBranches(branches: BranchInfo[], extraNames: string[] = []) {
  const groups = new Map<string, BranchInfo[]>();
  for (const name of extraNames) groups.set(name, []);
  for (const branch of branches) {
    const slash = branch.name.indexOf("/");
    const remote = slash === -1 ? branch.name : branch.name.slice(0, slash);
    const list = groups.get(remote) ?? [];
    list.push(branch);
    groups.set(remote, list);
  }
  return [...groups.entries()].sort(([left], [right]) => {
    if (left === "origin") return -1;
    if (right === "origin") return 1;
    return left.localeCompare(right);
  });
}

function shortRemoteName(fullName: string, remoteName: string) {
  const prefix = `${remoteName}/`;
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
}
