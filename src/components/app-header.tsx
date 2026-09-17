import { useState } from "react";
import {
  CheckIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGit } from "@/state/git-context";

export function AppHeader() {
  const {
    snapshot,
    view,
    setView,
    openFolder,
    closeRepo,
    refresh,
    checkoutBranch,
    createBranch,
    busy,
  } = useGit();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const repo = snapshot?.repo;
  const branches = snapshot?.branches.local ?? [];
  const current = repo?.isDetached
    ? repo.headId?.slice(0, 7) ?? "detached"
    : repo?.currentBranch ?? "unknown";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3">
      <div className="flex items-center gap-2">
        <GitBranchIcon className="size-4" />
        <span className="text-sm font-medium">Rebasely</span>
      </div>
      <Separator orientation="vertical" className="h-5" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="min-w-0 truncate text-sm text-muted-foreground hover:text-foreground"
            onClick={() => void closeRepo()}
          >
            {repo?.name}
          </button>
        </TooltipTrigger>
        <TooltipContent>{repo?.path} · Close</TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-56 font-mono">
            <GitBranchIcon data-icon="inline-start" />
            <span className="truncate">{current}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuLabel>Local branches</DropdownMenuLabel>
          {branches.map((branch) => (
            <DropdownMenuItem
              key={branch.name}
              disabled={branch.isHead || busy}
              onClick={() => void checkoutBranch(branch.name)}
            >
              <span className="min-w-4">
                {branch.isHead ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <span className="truncate font-mono">{branch.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setBranchOpen(true)}>
            <PlusIcon />
            New branch
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {repo?.ahead || repo?.behind ? (
        <span className="font-mono text-[11px] text-muted-foreground">
          {repo.ahead ? `↑${repo.ahead}` : null}
          {repo.ahead && repo.behind ? " " : null}
          {repo.behind ? `↓${repo.behind}` : null}
        </span>
      ) : null}

      <Tabs
        value={view}
        onValueChange={(value) => setView(value as "changes" | "history")}
        className="ml-2"
      >
        <TabsList>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void openFolder()} disabled={busy}>
              <FolderOpenIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Open repository
            <Kbd>Ctrl+O</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={busy}>
              <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Refresh
            <Kbd>Ctrl+R</Kbd>
          </TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setTheme((resolvedTheme ?? theme) === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <SunIcon className="hidden dark:block" />
          <MoonIcon className="dark:hidden" />
        </Button>
      </div>

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
              <Button type="submit" disabled={!newBranch.trim() || busy}>
                Create and checkout
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}
