import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { ChangeBadge } from "@/components/p4/change-badge";
import { P4Diff } from "@/components/p4/p4-diff";
import { HistorySkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { formatAbsoluteTime, formatExactTime } from "@/lib/format";
import { HoverTip } from "@/components/ui/tooltip";
import { changeSummary, depotBase, p4ActionClass, p4ActionLetter } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4Changelist } from "@/types/p4";

async function copyText(value: string, success: string) {
  if (!value) {
    toast.error("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success(success);
  } catch {
    toast.error("Could not copy");
  }
}

interface SubmittedSearch {
  query: string;
  user: string;
  client: string;
  changes: P4Changelist[];
  hasMore: boolean;
  scannedThrough: number | null;
}

export function P4Submitted() {
  const p4 = useP4();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [search, setSearch] = useState<SubmittedSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const connection = p4.connection;
  const scope = connection ? `${connection.port}\n${connection.client}` : "";
  const needle = query.trim().toLowerCase();
  const localMatches = useMemo(() => {
    if (!needle) return p4.submitted;
    return p4.submitted.filter((change) => changeMatches(change, needle));
  }, [needle, p4.submitted]);
  const remoteReady =
    needle.length > 0 &&
    search?.query === needle &&
    search.user === p4.submittedUser &&
    search.client === p4.submittedClient;
  const changes = useMemo(() => {
    if (!needle || !remoteReady || !search) return localMatches;
    return mergeById(search.changes, localMatches);
  }, [localMatches, needle, remoteReady, search]);
  const hasMore = needle ? Boolean(remoteReady && search?.hasMore) : p4.submittedHasMore;
  const listRef = useRef<HTMLDivElement>(null);
  const paging = useRef(false);
  const detail = p4.submittedDetail;
  const selectSubmitted = p4.selectSubmitted;
  const selectedSubmitted = p4.selectedSubmitted;
  const submitted = p4.submitted;
  const submittedLoading = p4.submittedLoading;
  const selectedRow = submitted.find((change) => change.id === selectedSubmitted) ?? null;
  const heading = detail
    ? changeSummary(detail.description) || `Change ${detail.id}`
    : selectedRow
      ? changeSummary(selectedRow.description) || `Change ${selectedRow.id}`
      : null;
  const file =
    picked && detail?.files.some((item) => item.depotPath === picked)
      ? picked
      : (detail?.files[0]?.depotPath ?? null);
  const diff = p4.submittedDiffs.find((item) => item.path === file) ?? null;
  const loadSubmitted = p4.loadSubmitted;
  const listUsers = p4.listUsers;
  const listClients = p4.listClients;
  const currentUser = connection?.user ?? "";
  const loaded = useRef({ scope: "", users: false, clientsFor: "" });

  useEffect(() => {
    if (!connection || loaded.current.scope === scope) return;
    loaded.current = { scope, users: false, clientsFor: "" };
    void loadSubmitted(false);
  }, [connection, loadSubmitted, scope]);

  useEffect(() => {
    if (selectedSubmitted || submittedLoading || submitted.length === 0) return;
    void selectSubmitted(submitted[0].id);
  }, [selectSubmitted, selectedSubmitted, submitted, submittedLoading]);

  function ensureUsers() {
    if (!connection || loaded.current.users) return;
    loaded.current.users = true;
    void listUsers()
      .then(setUsers)
      .catch(() => {
        loaded.current.users = false;
      });
  }

  function ensureClients(user: string) {
    if (!connection || !user || loaded.current.clientsFor === user) return;
    loaded.current.clientsFor = user;
    void listClients(user)
      .then(setClients)
      .catch(() => {
        loaded.current.clientsFor = "";
        setClients([]);
      });
  }

  const searchSubmitted = p4.searchSubmitted;
  const submittedUser = p4.submittedUser;
  const submittedClient = p4.submittedClient;

  useEffect(() => {
    if (!connection || !needle) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchSubmitted(needle, null, 40, 500)
        .then((page) => {
          if (!live || !page) return;
          setSearch({
            query: needle,
            user: submittedUser,
            client: submittedClient,
            changes: page.changes,
            hasMore: page.hasMore,
            scannedThrough: page.scannedThrough,
          });
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [connection, needle, searchSubmitted, submittedClient, submittedUser]);

  async function loadMore() {
    if (paging.current) return;
    if (needle) {
      if (!remoteReady || !search?.hasMore || search.scannedThrough == null || searching) return;
      paging.current = true;
      setSearching(true);
      try {
        let cursor: number | null = search.scannedThrough;
        let more = true;
        let accumulated = search.changes;
        let rounds = 0;
        while (more && cursor != null && rounds < 6) {
          rounds += 1;
          const page = await searchSubmitted(needle, cursor, 40, 400);
          if (!page) {
            more = false;
            break;
          }
          const beforeCount = accumulated.length;
          accumulated = appendChanges(accumulated, page.changes);
          more = page.hasMore;
          cursor = page.scannedThrough;
          if (accumulated.length > beforeCount) break;
        }
        setSearch((current) => {
          if (!current || current.query !== needle || current.user !== submittedUser || current.client !== submittedClient) {
            return current;
          }
          return { ...current, changes: accumulated, hasMore: more, scannedThrough: cursor };
        });
      } finally {
        paging.current = false;
        setSearching(false);
      }
      return;
    }
    if (!p4.submittedHasMore || p4.submittedLoading) return;
    paging.current = true;
    try {
      await loadSubmitted(p4.submitted.length > 0);
    } finally {
      paging.current = false;
    }
  }

  const loadMoreRef = useRef(loadMore);
  const autoLoads = useRef({ key: "", count: 0 });
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });

  useEffect(() => {
    const node = listRef.current;
    if (!node || !hasMore || searching || p4.submittedLoading) return;
    if (!needle && changes.length === 0) return;
    if (node.scrollHeight > node.clientHeight + 48) return;
    const key = `${needle}\n${submittedUser}\n${submittedClient}`;
    if (autoLoads.current.key !== key) autoLoads.current = { key, count: 0 };
    if (autoLoads.current.count >= 4) return;
    autoLoads.current.count += 1;
    void loadMoreRef.current();
  }, [changes.length, hasMore, needle, p4.submittedLoading, search?.scannedThrough, searching, submittedClient, submittedUser]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    if (node.scrollHeight - node.scrollTop - node.clientHeight > 240) return;
    void loadMoreRef.current();
  }

  const describing = Boolean(selectedSubmitted) && !detail && submittedLoading;
  const listBusy = needle ? searching : submittedLoading && !describing;

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-submitted-list" defaultSize="32%" minSize="22%" maxSize="48%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="grid shrink-0 gap-1.5 border-b p-2">
            <div className="grid grid-cols-2 gap-1.5">
              <FilterMenu
                label="User"
                value={p4.submittedUser}
                emptyLabel="All users"
                options={withCurrent(users, p4.submittedUser || currentUser)}
                onOpen={ensureUsers}
                onChange={(user) => {
                  const client = user === currentUser ? (connection?.client ?? "") : "";
                  p4.setSubmittedFilter(user, client);
                  if (user) ensureClients(user);
                  else setClients([]);
                }}
              />
              <FilterMenu
                label="Workspace"
                value={p4.submittedClient}
                emptyLabel="All workspaces"
                options={withCurrent(
                  p4.submittedUser ? clients : [],
                  p4.submittedClient || connection?.client || "",
                )}
                onOpen={() => ensureClients(p4.submittedUser)}
                onChange={(client) => p4.setSubmittedFilter(p4.submittedUser, client)}
              />
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter changelists"
              className="h-8"
            />
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-1 py-1" onScroll={onScroll}>
            {changes.length === 0 ? (
              listBusy ? (
                <HistorySkeleton rows={8} label={needle ? "Searching changelists" : "Loading changelists"} />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {needle ? "No matching changelists." : "No changelists."}
                </p>
              )
            ) : (
              <>
                {changes.map((change) => {
                  const active = change.id === p4.selectedSubmitted;
                  return (
                    <button
                      key={change.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/70",
                        active && "bg-muted",
                      )}
                      onClick={() => void p4.selectSubmitted(change.id)}
                    >
                      <ChangeBadge id={change.id} />
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {changeSummary(change.description) || "No description"}
                      </span>
                      {change.time ? (
                        <HoverTip label={formatExactTime(change.time)}>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {formatAbsoluteTime(change.time)}
                          </span>
                        </HoverTip>
                      ) : null}
                    </button>
                  );
                })}
                {listBusy ? (
                  <p className="px-2 py-2 text-center text-xs text-muted-foreground">
                    {needle ? "Searching older changelists" : "Loading"}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-submitted-main" defaultSize="68%" minSize="40%">
        <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0">
          <ResizablePanel id="p4-submitted-files" defaultSize="32%" minSize="16%">
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b px-3 py-2">
                <div className="truncate text-sm">{heading}</div>
                {p4.submittedDetail ? (
                  <div className="mt-1 flex items-center gap-x-2 text-[11px] text-muted-foreground">
                    <HoverTip label="Copy user">
                    <button
                      type="button"
                      className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted hover:text-foreground"
                      onClick={() => void copyText(p4.submittedDetail?.user ?? "", "Copied user")}
                    >
                      <AuthorAvatar name={p4.submittedDetail.user} email="" className="size-4" />
                      <span className="truncate">{p4.submittedDetail.user}</span>
                    </button>
                    </HoverTip>
                    {p4.submittedDetail.time ? (
                      <HoverTip label={formatExactTime(p4.submittedDetail.time)}>
                      <button
                        type="button"
                        className="shrink-0 rounded-md px-1 py-0.5 tabular-nums hover:bg-muted hover:text-foreground"
                        onClick={() => void copyText(formatExactTime(p4.submittedDetail?.time ?? 0), "Copied time")}
                      >
                        {formatAbsoluteTime(p4.submittedDetail.time)}
                      </button>
                      </HoverTip>
                    ) : null}
                    <HoverTip label="Copy changelist">
                    <button
                      type="button"
                      className="shrink-0 rounded-md px-1 py-0.5 font-mono hover:bg-muted hover:text-foreground"
                      onClick={() => void copyText(p4.submittedDetail?.id ?? "", "Copied changelist")}
                    >
                      #{p4.submittedDetail.id}
                    </button>
                    </HoverTip>
                  </div>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
                {p4.submittedDetail?.files.map((item) => (
                  <button
                    key={item.depotPath}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
                      file === item.depotPath && "bg-muted",
                    )}
                    onClick={() => setPicked(item.depotPath)}
                  >
                    <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-medium", p4ActionClass(item.action))}>
                      {p4ActionLetter(item.action)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">{depotBase(item.depotPath)}</span>
                    {item.binary || p4.submittedDiffs.some((diff) => diff.binary && diff.path === item.depotPath) ? (
                      <span className="shrink-0 text-muted-foreground">binary</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="p4-submitted-diff" defaultSize="68%" minSize="24%">
            <P4Diff
              diff={diff}
              loading={p4.submittedLoading && !p4.submittedDetail}
              empty={p4.selectedSubmitted ? "Select a file to see its diff" : "Select a changelist"}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function changeMatches(change: P4Changelist, needle: string) {
  return (
    change.id.includes(needle) ||
    change.user.toLowerCase().includes(needle) ||
    change.description.toLowerCase().includes(needle)
  );
}

function mergeById(remote: P4Changelist[], local: P4Changelist[]) {
  const byId = new Map<string, P4Changelist>();
  for (const change of remote) byId.set(change.id, change);
  for (const change of local) {
    if (!byId.has(change.id)) byId.set(change.id, change);
  }
  return [...byId.values()].sort((left, right) => Number(right.id) - Number(left.id));
}

function appendChanges(current: P4Changelist[], next: P4Changelist[]) {
  const seen = new Set(current.map((change) => change.id));
  return [...current, ...next.filter((change) => !seen.has(change.id))];
}

function withCurrent(options: string[], current: string) {
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

function FilterMenu({
  label,
  value,
  emptyLabel,
  options,
  onOpen,
  onChange,
}: {
  label: string;
  value: string;
  emptyLabel: string;
  options: string[];
  onOpen: () => void;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (needle ? options.filter((option) => option.toLowerCase().includes(needle)) : options).slice(0, 80);
  const typed = query.trim();
  const canUseTyped = typed.length > 0 && !options.some((option) => option.toLowerCase() === typed.toLowerCase());
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen();
        else setQuery("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-between px-2 font-normal">
          <span className="min-w-0 truncate font-mono text-xs">{value || emptyLabel}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="px-1.5 pb-1.5" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${label.toLowerCase()}`}
            className="h-7"
          />
        </div>
        <div className="max-h-64 overflow-auto">
          {!needle ? (
            <DropdownMenuItem onClick={() => onChange("")}>
              <span className="min-w-4">{value === "" ? <CheckIcon className="size-3.5" /> : null}</span>
              {emptyLabel}
            </DropdownMenuItem>
          ) : null}
          {shown.map((option) => (
            <DropdownMenuItem key={option} onClick={() => onChange(option)}>
              <span className="min-w-4">{option === value ? <CheckIcon className="size-3.5" /> : null}</span>
              <span className="truncate font-mono">{option}</span>
            </DropdownMenuItem>
          ))}
          {canUseTyped ? (
            <DropdownMenuItem onClick={() => onChange(typed)}>
              <span className="min-w-4" />
              <span className="truncate font-mono">Use {typed}</span>
            </DropdownMenuItem>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
