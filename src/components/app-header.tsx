import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CodeXmlIcon,
  FolderOpenIcon,
  PlusIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActivityMeter } from "@/components/activity-meter";
import { AppMenu } from "@/components/app-menu";
import { AppToolbar } from "@/components/app-toolbar";
import { P4Header } from "@/components/p4/p4-header";
import { VcsIcon } from "@/components/vcs-icon";
import { WindowControls } from "@/components/window-controls";
import { CreateBranchDialog } from "@/components/create-ref-dialogs";
import { defaultBranchRank, groupRemoteBranches, remoteGroupRank, shortRemoteName } from "@/lib/branches";
import { disambiguateRepoLabels } from "@/lib/format";
import { isRemoteTrackingBranch } from "@/lib/git";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { desktopPlatform } from "@/lib/desktop-platform";
import { useGitPick, type AppTab } from "@/state/git-context";
import type { BranchInfo } from "@/types/git";

export function AppHeader() {
  const {
    snapshot,
    tabs,
    activeTab,
    activeTabId,
    setActiveTab,
    closeTab,
    reorderTabs,
    revealRepo,
    openWelcomeTab,
    openTerminal,
    openInEditor,
    ensureBranches,
    checkoutBranch,
    openPanel,
    setOpenPanel,
  } = useGitPick([
    "snapshot",
    "tabs",
    "activeTab",
    "activeTabId",
    "setActiveTab",
    "closeTab",
    "reorderTabs",
    "revealRepo",
    "openWelcomeTab",
    "openTerminal",
    "openInEditor",
    "ensureBranches",
    "checkoutBranch",
    "openPanel",
    "setOpenPanel",
  ]);
  const branchOpen = openPanel === "new-branch";
  const setBranchOpen = (open: boolean) => setOpenPanel(open ? "new-branch" : null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const repo = snapshot?.repo;
  const local = snapshot?.branches.local ?? [];
  const remoteBranches = snapshot?.branches.remote;
  const remotes = snapshot?.remotes;
  const remote = useMemo(() => {
    const remoteNames = remotes?.map((item) => item.name) ?? [];
    return (remoteBranches ?? []).filter((branch) => isRemoteTrackingBranch(branch.name, remoteNames));
  }, [remoteBranches, remotes]);
  const query = branchQuery.trim().toLowerCase();
  const remoteGroups = useMemo(() => groupRemoteBranches(remote), [remote]);
  const filteredRemote = useMemo(() => {
    if (!query) return [];
    return remote
      .filter((branch) => branch.name.toLowerCase().includes(query))
      .sort((left, right) => {
        const leftRemote = left.name.split("/")[0] ?? left.name;
        const rightRemote = right.name.split("/")[0] ?? right.name;
        const remoteRank = remoteGroupRank(leftRemote) - remoteGroupRank(rightRemote);
        if (remoteRank !== 0) return remoteRank;
        const nameRank = defaultBranchRank(left.name) - defaultBranchRank(right.name);
        return nameRank !== 0 ? nameRank : left.name.localeCompare(right.name);
      })
      .slice(0, 80);
  }, [query, remote]);
  const current = repo?.isDetached
    ? (repo.headId?.slice(0, 7) ?? "detached")
    : (repo?.currentBranch ?? "unknown");
  const perforce = activeTab.kind === "repo" && activeTab.vcs === "perforce";
  const repoOpen = activeTab.kind === "repo";
  return (
    <header className="shrink-0 bg-background">
      <div className={cn("flex items-stretch", desktopPlatform() === "macos" ? "h-11 pl-[84px]" : "h-9")}>
        <AppMenu />
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          setActiveTab={setActiveTab}
          closeTab={closeTab}
          reorderTabs={reorderTabs}
          onOpenWelcome={() => openWelcomeTab()}
        />
        <WindowControls />
      </div>

      <div className="flex h-9 items-center gap-1.5 border-y px-2">
        {perforce ? (
          <P4Header />
        ) : repo ? (
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
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-80 p-0">
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
              <HoverTip label={repo?.headId ? undefined : "Create a commit first"}>
                <span className="block">
                  <DropdownMenuItem disabled={!repo?.headId} aria-description={repo?.headId ? undefined : "Create a commit first"} onClick={() => setBranchOpen(true)}>
                    <PlusIcon />
                    New branch
                  </DropdownMenuItem>
                </span>
              </HoverTip>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}

      {repo && !perforce ? <AppToolbar /> : null}

      <ActivityMeter />

      {repoOpen ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Open in editor"
                onClick={() => void openInEditor()}
              >
                <CodeXmlIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in editor</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Open terminal" onClick={() => void openTerminal()}>
                <SquareTerminalIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open terminal</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Open repository folder" onClick={() => void revealRepo()}>
                <FolderOpenIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open folder</TooltipContent>
          </Tooltip>
        </>
      ) : null}
      </div>

      <CreateBranchDialog open={branchOpen} onOpenChange={setBranchOpen} />
    </header>
  );
}

function TabStrip({
  tabs: allTabs,
  activeTabId,
  setActiveTab,
  closeTab,
  reorderTabs,
  onOpenWelcome,
}: {
  tabs: AppTab[];
  activeTabId: string;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (fromId: string, toId: string, place: "before" | "after") => void;
  onOpenWelcome: () => void;
}) {
  const tabs = useMemo(
    () => allTabs.filter((tab) => tab.kind === "repo"),
    [allTabs],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; active: boolean } | null>(null);
  const reorderTabsRef = useRef(reorderTabs);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  useLayoutEffect(() => {
    reorderTabsRef.current = reorderTabs;
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    const containerNode = container;
    const measureNode = measure;

    function update() {
      const nodes = Array.from(measureNode.children) as HTMLElement[];
      if (nodes.length === 0) return;
      const gap = 4;
      const moreWidth = 56;
      const plusWidth = 32;
      const dragReserve = 32;
      const available = Math.max(0, containerNode.clientWidth - plusWidth - dragReserve);
      const widths = nodes.map((node) => node.offsetWidth);

      let used = 0;
      let count = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const remaining = widths.length - index - 1;
        const overflowSpace = remaining > 0 ? gap + moreWidth : 0;
        if (count > 0 && used + gap + widths[index] + overflowSpace > available) break;
        used += (count > 0 ? gap : 0) + widths[index];
        count += 1;
      }
      count = Math.max(1, Math.min(count, tabs.length));

      let visible = tabs.slice(0, count);
      if (!visible.some((tab) => tab.id === activeTabId)) {
        const active = tabs.find((tab) => tab.id === activeTabId);
        if (active) {
          visible = [...visible.slice(0, Math.max(visible.length - 1, 0)), active];
        }
      }
      const visibleSet = new Set(visible.map((tab) => tab.id));
      setHiddenIds(tabs.filter((tab) => !visibleSet.has(tab.id)).map((tab) => tab.id));
    }

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [activeTabId, tabs]);

  useEffect(() => {
    function dropTargetAt(clientX: number): { id: string; place: "before" | "after" } | null {
      const nodes = stripRef.current
        ? Array.from(stripRef.current.querySelectorAll<HTMLElement>("[data-tab-id]"))
        : [];
      if (nodes.length === 0) return null;
      for (const node of nodes) {
        const id = node.dataset.tabId;
        if (!id) continue;
        const rect = node.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          return { id, place: "before" };
        }
      }
      const lastId = nodes[nodes.length - 1]?.dataset.tabId;
      return lastId ? { id: lastId, place: "after" } : null;
    }

    function onPointerMove(event: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active && Math.abs(event.clientX - drag.startX) < 6) return;
      if (!drag.active) {
        drag.active = true;
        setDraggingId(drag.id);
      }
      const target = dropTargetAt(event.clientX);
      if (target && target.id !== drag.id) {
        reorderTabsRef.current(drag.id, target.id, target.place);
      }
    }

    function endDrag() {
      if (!dragRef.current) {
        setDraggingId((current) => (current == null ? current : null));
        return;
      }
      dragRef.current = null;
      setDraggingId(null);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  const hidden = tabs.filter((tab) => hiddenIds.includes(tab.id));
  const visible = tabs.filter((tab) => !hiddenIds.includes(tab.id));
  const labels = useMemo(
    () =>
      disambiguateRepoLabels(
        tabs.flatMap((tab) => (tab.kind === "repo" ? [{ path: tab.path, name: tab.name }] : [])),
      ),
    [tabs],
  );

  function canClose(tab: AppTab) {
    return tab.kind === "repo" || tabs.length > 1;
  }

  function tabLabel(tab: AppTab) {
    if (tab.kind === "welcome") return "Welcome";
    if (tab.kind === "repo" && tab.vcs === "perforce") return tab.name;
    return labels.get(tab.path) ?? tab.name;
  }

  function handleTabPointerDown(tabId: string, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    dragRef.current = { id: tabId, startX: event.clientX, active: false };
    setActiveTab(tabId);
  }

  return (
    <div ref={containerRef} className="relative flex h-full min-w-0 flex-1">
      <div
        ref={measureRef}
        className="pointer-events-none invisible absolute flex items-center gap-1"
        aria-hidden
      >
        {tabs.map((tab) => (
          <TabButton
            key={`measure:${tab.id}`}
            tab={tab}
            label={tabLabel(tab)}
            active={tab.id === activeTabId}
            closable={canClose(tab)}
            onSelect={() => undefined}
            onClose={() => undefined}
          />
        ))}
      </div>
      <div
        ref={stripRef}
        className={cn("flex h-full w-full min-w-0 items-center gap-1 pl-1", draggingId && "select-none")}
      >
        {visible.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            label={tabLabel(tab)}
            active={tab.id === activeTabId}
            closable={canClose(tab)}
            dragging={tab.id === draggingId}
            onSelect={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onPointerDown={(event) => handleTabPointerDown(tab.id, event)}
          />
        ))}
        {hidden.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="shrink-0 px-1.5">
                {hidden.length}
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              {hidden.map((tab) => {
                const label = tabLabel(tab);
                return (
                  <DropdownMenuItem
                    key={tab.id}
                    className="gap-2"
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <VcsIcon vcs={tab.kind === "repo" ? tab.vcs : "git"} className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {canClose(tab) ? (
                      <button
                        type="button"
                        className="flex size-4 items-center justify-center rounded-sm hover:bg-muted"
                        aria-label={`Close ${label}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                      >
                        <XIcon className="size-3" />
                      </button>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label="Welcome"
              onClick={onOpenWelcome}
            >
              <PlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Welcome</TooltipContent>
        </Tooltip>
        <div
          className="h-full min-h-9 min-w-8 flex-1"
          data-tauri-drag-region
          onDoubleClick={() => void getCurrentWindow().toggleMaximize()}
        />
      </div>
    </div>
  );
}

function TabButton({
  tab,
  label,
  active,
  closable,
  dragging = false,
  onSelect,
  onClose,
  onPointerDown,
}: {
  tab: AppTab;
  label: string;
  active: boolean;
  closable: boolean;
  dragging?: boolean;
  onSelect: () => void;
  onClose: () => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const hint = tab.kind === "welcome" ? "Open or clone a repository" : tab.path;
  const interactive = Boolean(onPointerDown);

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
          data-tab-id={interactive ? tab.id : undefined}
          onPointerDown={onPointerDown}
          className={cn(
            "group flex h-8 max-w-52 shrink-0 items-center rounded-md pr-1 text-sm",
            interactive && "cursor-grab touch-none",
            dragging && "cursor-grabbing opacity-60",
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
            {tab.kind === "repo" ? <VcsIcon vcs={tab.vcs} className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{label}</span>
          </button>
          {closable ? (
            <button
              type="button"
              className={cn(
                "flex size-4 items-center justify-center rounded-sm hover:bg-background/80",
                active
                  ? "opacity-100"
                  : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
              )}
              onPointerDown={(event) => event.stopPropagation()}
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

function VirtualBranchList({
  items,
  remoteName,
  onPick,
}: {
  items: BranchInfo[];
  remoteName: string;
  onPick: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const row = 36;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((branch) => {
      const short = shortRemoteName(branch.name, remoteName).toLowerCase();
      return short.includes(needle) || branch.name.toLowerCase().includes(needle);
    });
  }, [items, query, remoteName]);
  const rows = useWindowedRows(filtered.length, row, 6);
  const height = Math.min(320, Math.max(filtered.length === 0 ? 48 : row, filtered.length * row));

  return (
    <div className="flex flex-col">
      <div className="border-b px-2 py-2" onPointerDown={(event) => event.stopPropagation()}>
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            rows.viewport?.scrollTo({ top: 0 });
          }}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Filter branches"
          className="h-7"
        />
      </div>
      <ScrollArea viewportRef={rows.viewportRef} style={{ height }}>
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-3 text-xs text-muted-foreground">
            No matching branches
          </div>
        ) : (
          <div>
            <div style={{ height: rows.before }} />
            {filtered.slice(rows.start, rows.end).map((branch) => (
              <button
                key={branch.name}
                type="button"
                className="flex w-full items-center truncate px-3 text-left font-mono text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ height: row }}
                onClick={() => onPick(branch.name)}
              >
                {shortRemoteName(branch.name, remoteName)}
              </button>
            ))}
            <div style={{ height: rows.after }} />
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
