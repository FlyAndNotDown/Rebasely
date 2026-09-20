import { useMemo, useState, type MouseEvent, type UIEvent } from "react";
import {
  CheckIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActivityMeter } from "@/components/activity-meter";
import { cn } from "@/lib/utils";
import { useGit, type AppTab } from "@/state/git-context";
import type { BranchInfo } from "@/types/git";

export function AppHeader() {
  const {
    snapshot,
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    openFolder,
    revealRepo,
    openTerminal,
    ensureBranches,
    checkoutBranch,
    createBranch,
  } = useGit();
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const repo = snapshot?.repo;
  const local = snapshot?.branches.local ?? [];
  const remote = snapshot?.branches.remote ?? [];
  const query = branchQuery.trim().toLowerCase();
  const remoteGroups = useMemo(() => groupRemoteBranches(remote), [remote]);
  const filteredRemote = useMemo(() => {
    if (!query) return [];
    return remote.filter((branch) => branch.name.toLowerCase().includes(query)).slice(0, 80);
  }, [query, remote]);
  const current = repo?.isDetached
    ? (repo.headId?.slice(0, 7) ?? "detached")
    : (repo?.currentBranch ?? "unknown");

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-2">
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              onClick={() => void openFolder()}
              aria-label="Open repository"
            >
              <PlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Open repository
            <Kbd>Ctrl+O</Kbd>
          </TooltipContent>
        </Tooltip>
      </nav>

      <ActivityMeter />

      {repo ? (
        <>
          <DropdownMenu
            open={branchMenuOpen}
            onOpenChange={(open) => {
              setBranchMenuOpen(open);
              if (open) void ensureBranches();
              else setBranchQuery("");
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="max-w-44 shrink-0 font-mono">
                <GitBranchIcon data-icon="inline-start" />
                <span className="truncate">{current}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-80">
              <div className="px-1.5 pb-1.5" onPointerDown={(event) => event.stopPropagation()}>
                <Input
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  placeholder="Filter branches"
                  className="h-7"
                />
              </div>
              <DropdownMenuLabel>Local branches</DropdownMenuLabel>
              {local
                .filter((branch) => !query || branch.name.toLowerCase().includes(query))
                .map((branch) => (
                  <DropdownMenuItem
                    key={`local:${branch.name}`}
                    disabled={branch.isHead}
                    onClick={() => void checkoutBranch(branch.name)}
                  >
                    <span className="min-w-4">
                      {branch.isHead ? <CheckIcon className="size-3.5" /> : null}
                    </span>
                    <span className="truncate font-mono">{branch.name}</span>
                  </DropdownMenuItem>
                ))}
              {remote.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Remote branches</DropdownMenuLabel>
                  {query
                    ? filteredRemote.map((branch) => (
                        <DropdownMenuItem
                          key={`remote:${branch.name}`}
                          onClick={() => void checkoutBranch(branch.name)}
                        >
                          <span className="truncate font-mono text-muted-foreground">
                            {branch.name}
                          </span>
                        </DropdownMenuItem>
                      ))
                    : remoteGroups.map(([remoteName, branches]) => (
                        <DropdownMenuSub key={remoteName}>
                          <DropdownMenuSubTrigger>
                            <span className="truncate font-mono">{remoteName}</span>
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {branches.length}
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-72 p-0">
                            <VirtualBranchList
                              items={branches}
                              remoteName={remoteName}
                              onPick={(name) => {
                                setBranchMenuOpen(false);
                                void checkoutBranch(name);
                              }}
                            />
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      ))}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setBranchOpen(true)}>
                <PlusIcon />
                New branch
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {repo.ahead || repo.behind ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {repo.ahead ? `↑${repo.ahead}` : null}
              {repo.ahead && repo.behind ? " " : null}
              {repo.behind ? `↓${repo.behind}` : null}
            </span>
          ) : null}
        </>
      ) : null}

      {repo ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => void openTerminal()}>
                <SquareTerminalIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open terminal</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => void revealRepo()}>
                <FolderOpenIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open folder</TooltipContent>
          </Tooltip>
        </>
      ) : null}

      <Dialog open={branchOpen} onOpenChange={setBranchOpen}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = newBranch.trim();
              if (!name) return;
              void createBranch(name, true);
              setNewBranch("");
              setBranchOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Create branch</DialogTitle>
              <DialogDescription>
                Creates a branch from the current HEAD and checks it out.
              </DialogDescription>
            </DialogHeader>
            <Input
              className="mt-3 font-mono"
              autoFocus
              placeholder="feature/name"
              value={newBranch}
              onChange={(event) => setNewBranch(event.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setBranchOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newBranch.trim()}>
                Create and checkout
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: AppTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const closable = tab.kind === "repo";
  const label = tab.kind === "welcome" ? "Rebasely" : tab.name;
  const hint = tab.kind === "welcome" ? "Welcome" : tab.path;

  function handleAuxClick(event: MouseEvent<HTMLButtonElement>) {
    if (event.button === 1 && closable) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "group flex h-8 max-w-52 shrink-0 items-center rounded-md pr-1 text-sm",
            active
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <button
            type="button"
            onClick={onSelect}
            onAuxClick={handleAuxClick}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2"
          >
            {tab.kind === "welcome" ? <GitBranchIcon className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{label}</span>
          </button>
          {closable ? (
            <button
              type="button"
              className={cn(
                "flex size-4 items-center justify-center rounded-sm hover:bg-background/80",
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={onClose}
              aria-label={`Close ${label}`}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function groupRemoteBranches(branches: BranchInfo[]) {
  const groups = new Map<string, BranchInfo[]>();
  for (const branch of branches) {
    const slash = branch.name.indexOf("/");
    const remote = slash === -1 ? branch.name : branch.name.slice(0, slash);
    const list = groups.get(remote) ?? [];
    list.push(branch);
    groups.set(remote, list);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function shortRemoteName(fullName: string, remoteName: string) {
  const prefix = `${remoteName}/`;
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
}

function VirtualBranchList({
  items,
  remoteName,
  onPick,
}: {
  items: BranchInfo[];
  remoteName: string;
  onPick: (name: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const row = 28;
  const height = Math.min(320, Math.max(row, items.length * row));
  const start = Math.max(0, Math.floor(scrollTop / row) - 6);
  const visible = Math.ceil(height / row) + 12;
  const slice = items.slice(start, start + visible);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <div className="overflow-y-auto" style={{ height }} onScroll={onScroll}>
      <div className="relative" style={{ height: items.length * row }}>
        {slice.map((branch, index) => (
          <button
            key={branch.name}
            type="button"
            className="absolute right-0 left-0 truncate px-2 text-left font-mono text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            style={{ top: (start + index) * row, height: row }}
            onClick={() => onPick(branch.name)}
          >
            {shortRemoteName(branch.name, remoteName)}
          </button>
        ))}
      </div>
    </div>
  );
}
