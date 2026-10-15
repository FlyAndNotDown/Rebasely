import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { ChangeBadge } from "@/components/p4/change-badge";
import { P4Diff } from "@/components/p4/p4-diff";
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

export function P4Submitted() {
  const p4 = useP4();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const connection = p4.connection;
  const scope = connection ? `${connection.port}\n${connection.client}` : "";
  const needle = query.trim().toLowerCase();
  const changes = p4.submitted.filter((change) => {
    if (!needle) return true;
    return (
      change.id.includes(needle) ||
      change.user.toLowerCase().includes(needle) ||
      change.description.toLowerCase().includes(needle)
    );
  });
  const detail = p4.submittedDetail;
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
          <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
            {changes.length === 0 && !p4.submittedLoading ? (
              <p className="p-4 text-sm text-muted-foreground">No submitted changelists.</p>
            ) : (
              changes.map((change) => {
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
              })
            )}
          </div>
          {p4.submittedHasMore ? (
            <div className="shrink-0 border-t p-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full"
                disabled={p4.submittedLoading}
                onClick={() => void p4.loadSubmitted(p4.submitted.length > 0)}
              >
                {p4.submittedLoading ? "Loading" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-submitted-main" defaultSize="68%" minSize="40%">
        <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0">
          <ResizablePanel id="p4-submitted-files" defaultSize="32%" minSize="16%">
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b px-3 py-2">
                <div className="truncate text-sm">
                  {p4.submittedDetail
                    ? changeSummary(p4.submittedDetail.description) || `Change ${p4.submittedDetail.id}`
                    : "Submitted"}
                </div>
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
