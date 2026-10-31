import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, FolderOpenIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { ActivityBar } from "@/components/activity-meter";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { createExclusiveAction, createLatestRequest } from "@/lib/async-scope";
import { P4_LOGIN, p4Api } from "@/lib/p4";
import type { P4Auth, P4ClientOption, P4DepotEntry, P4StreamOption } from "@/types/p4";
import { useActivities, useGitPick } from "@/state/git-context";

function repoNameFromUrl(url: string) {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  const withoutGit = trimmed.replace(/\.git$/i, "");
  const name = withoutGit.split(/[/:]/).pop()?.trim() ?? "";
  if (!isFolderName(name)) return "";
  return name;
}

function isFolderName(name: string) {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !/[\\/:*?"<>|]/.test(trimmed)
  );
}

function joinPath(parent: string, name: string) {
  const sep = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name.trim()}`;
}

export function CloneRepositoryDialog({
  open: isOpen,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [cloning, setCloning] = useState(false);
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (cloning) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl" showCloseButton={!cloning}>
        {/* The form unmounts when the dialog closes, so every open starts empty. */}
        {isOpen ? <CloneForm cloning={cloning} setCloning={setCloning} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CloneForm({
  cloning,
  setCloning,
  onOpenChange,
}: {
  cloning: boolean;
  setCloning: (cloning: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<"git" | "perforce">("git");
  return (
    <div>
      <SegmentedControl
        label="Repository kind"
        value={kind}
        disabled={cloning}
        className="mb-4 w-fit"
        onChange={setKind}
        options={[
          { value: "git", label: "Git" },
          { value: "perforce", label: "Perforce" },
        ]}
      />
      {kind === "git" ? (
        <GitCloneForm cloning={cloning} setCloning={setCloning} onOpenChange={onOpenChange} />
      ) : (
        <P4CloneForm cloning={cloning} setCloning={setCloning} onOpenChange={onOpenChange} />
      )}
    </div>
  );
}

function GitCloneForm({
  cloning,
  setCloning,
  onOpenChange,
}: {
  cloning: boolean;
  setCloning: (cloning: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { cloneRepository } = useGitPick(["cloneRepository"]);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [mutation] = useState(createExclusiveAction);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);

  const folderOk = isFolderName(folder);
  const destination = parent && folderOk ? joinPath(parent, folder) : "";
  const canClone = url.trim().length > 0 && Boolean(destination) && !cloning;

  function onUrlChange(next: string) {
    setUrl(next);
    if (!folderEdited) setFolder(repoNameFromUrl(next));
  }

  async function browse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose clone location",
    });
    if (typeof selected === "string") setParent(selected);
  }

  async function submit() {
    if (!canClone) return;
    await mutation.run(async () => {
      setActivityId(null);
      setIncomplete(false);
      setCloning(true);
      try {
        const ok = await cloneRepository(url.trim(), destination, setActivityId);
        if (ok) onOpenChange(false);
        else setIncomplete(true);
      } finally {
        setActivityId(null);
        setCloning(false);
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
        <DialogTitle>Open remote repository</DialogTitle>
        <DialogDescription>
          Clones a remote repository into a local folder and opens it.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-3 grid min-w-0 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="clone-url">URL</Label>
          <Input
            id="clone-url"
            className="font-mono"
            autoFocus
            disabled={cloning}
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="https://github.com/org/repo.git"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="clone-folder">Folder name</Label>
          <Input
            id="clone-folder"
            className="font-mono"
            disabled={cloning}
            value={folder}
            onChange={(event) => {
              setFolderEdited(true);
              setFolder(event.target.value);
            }}
            placeholder="repo"
          />
          {folder.trim() && !folderOk ? (
            <p className="text-xs text-destructive">
              Folder name cannot include \ / : * ? &quot; &lt; &gt; |
            </p>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="clone-parent">Location</Label>
          <div className="flex min-w-0 gap-2">
            <HoverTip label={parent}>
              <Input
                id="clone-parent"
                className="min-w-0 font-mono"
                readOnly
                value={parent}
                placeholder="Choose a parent folder"
              />
            </HoverTip>
            <Button
              type="button"
              variant="outline"
              disabled={cloning}
              onClick={() => void browse()}
            >
              <FolderOpenIcon data-icon="inline-start" />
              Browse
            </Button>
          </div>
          {destination ? (
            <HoverTip label={destination}>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{destination}</p>
            </HoverTip>
          ) : null}
        </div>
      </div>
      <GitCloneActivity activityId={activityId} cloning={cloning} canClone={canClone} incomplete={incomplete} onClose={() => onOpenChange(false)} />
    </form>
  );
}

function GitCloneActivity({ activityId, cloning, canClone, incomplete, onClose }: {
  activityId: string | null;
  cloning: boolean;
  canClone: boolean;
  incomplete: boolean;
  onClose: () => void;
}) {
  const activity = useActivities().find((item) => item.id === activityId);
  const latest = useRef(activity);
  const liveId = useRef(activityId);
  const cancellingRequest = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState(activity);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; message: string } | null>(null);
  const cancelling = cloning && activityId !== null && cancellingId === activityId;
  const shown = activity ? snapshot?.id === activityId ? snapshot : activity : undefined;
  const progress = shown?.progress === undefined || !Number.isFinite(shown.progress)
    ? undefined
    : Math.max(0, Math.min(100, Math.round(shown.progress)));

  useLayoutEffect(() => { latest.current = activity; }, [activity]);
  useLayoutEffect(() => {
    liveId.current = activityId;
    cancellingRequest.current = null;
    return () => { liveId.current = null; };
  }, [activityId]);
  useEffect(() => {
    if (!cloning) return;
    const timer = window.setInterval(() => {
      setSnapshot((current) => current === latest.current ? current : latest.current);
    }, 150);
    return () => window.clearInterval(timer);
  }, [cloning]);

  async function cancel() {
    if (!cloning || !activityId || !activity?.cancellable || cancellingRequest.current === activityId) return;
    const id = activityId;
    cancellingRequest.current = id;
    setCancellingId(id);
    setCancelError(null);
    let accepted = false;
    try {
      accepted = await gitApi.cancelActivity(id);
      if (liveId.current !== id) return;
      if (!accepted) {
        setCancellingId(null);
        setCancelError({ id, message: "Cancellation is not available yet. Try again shortly." });
      }
    } catch {
      if (liveId.current === id) {
        setCancellingId(null);
        setCancelError({ id, message: "Could not cancel cloning. Try again." });
      }
    } finally {
      if (!accepted && cancellingRequest.current === id) cancellingRequest.current = null;
    }
  }

  return (
    <>
      {cloning ? (
        <div className="mt-4 grid gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <p role="status">{cancelling ? "Cancelling clone…" : activity ? "Cloning repository…" : activityId ? "Opening repository…" : "Preparing clone…"}</p>
            {progress !== undefined && !cancelling ? <span className="shrink-0 tabular-nums text-muted-foreground">{progress}%</span> : null}
          </div>
          {shown ? <div role="progressbar" aria-label="Clone progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><ActivityBar activity={{ ...shown, progress }} /></div> : null}
          {shown?.detail ? <p className="truncate font-mono text-[11px] text-muted-foreground">{shown.detail}</p> : null}
          {activity && cancelError?.id === activityId ? <p role="alert" className="text-xs text-destructive">{cancelError.message}</p> : null}
        </div>
      ) : incomplete ? <p role="status" className="mt-4 text-xs text-muted-foreground">Clone did not complete. Check the details and retry.</p> : null}
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" disabled={cloning && (!activity?.cancellable || cancelling)} onClick={() => { if (cloning) void cancel(); else onClose(); }}>
          {cancelling ? "Cancelling…" : cloning ? "Cancel clone" : "Cancel"}
        </Button>
        <Button type="submit" disabled={!canClone}>
          {cloning ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}
          Clone
        </Button>
      </DialogFooter>
    </>
  );
}

function P4CloneForm({
  cloning,
  setCloning,
  onOpenChange,
}: {
  cloning: boolean;
  setCloning: (cloning: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { prefs, openPath, updatePrefs, beginActivity, endActivity } = useGitPick([
    "prefs",
    "openPath",
    "updatePrefs",
    "beginActivity",
    "endActivity",
  ]);
  const [port, setPort] = useState(prefs.p4Port);
  const [user, setUser] = useState(prefs.p4User);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [server, setServer] = useState("");
  const [clients, setClients] = useState<P4ClientOption[] | null>(null);
  const [client, setClient] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const mounted = useRef(false);
  const latestPrefs = useRef(prefs);
  const [connectionCheck] = useState(createExclusiveAction);
  const [mutation] = useState(createExclusiveAction);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { latestPrefs.current = prefs; }, [prefs]);

  function forgetCheck() {
    setServer("");
    setClients(null);
    setClient("");
  }

  function auth(): P4Auth {
    return { port: port.trim(), user: user.trim(), password, charset: prefs.p4Charset };
  }

  const selected = clients?.find((item) => item.name === client) ?? null;

  async function check() {
    if (!port.trim() || !user.trim()) return;
    await connectionCheck.run(async () => {
      setChecking(true);
      forgetCheck();
      const credentials = auth();
      try {
        const checked = await p4Api.checkConnection(credentials);
        if (!mounted.current) return;
        setServer(checked.server);
        setClients(checked.clients);
        await updatePrefs({ ...latestPrefs.current, p4Port: credentials.port, p4User: credentials.user });
      } catch (error) {
        if (!mounted.current) return;
        const message = errorMessage(error);
        toast.error(message === P4_LOGIN ? "Enter the password for this user and try again." : message);
      } finally {
        if (mounted.current) setChecking(false);
      }
    });
  }

  async function openClient() {
    if (!selected || checking) return;
    await mutation.run(async () => {
      setCloning(true);
      const id = beginActivity("Opening workspace", selected.name);
      try {
        const root = await p4Api.prepareClient(auth(), selected.name);
        await openPath(root, "perforce");
        onOpenChange(false);
      } catch (error) {
        const message = errorMessage(error);
        toast.error(message === P4_LOGIN ? "Enter the password for this user and try again." : message);
      } finally {
        endActivity(id);
        setCloning(false);
      }
    });
  }

  function startCreate() { setCreateOpen(true); }

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void openClient();
        }}
      >
        <DialogHeader>
          <DialogTitle>Open remote repository</DialogTitle>
          <DialogDescription>
            Check the server, then open one of that user's clients or create a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-3 grid min-w-0 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="p4-port">Server</Label>
            <Input
              id="p4-port"
              className="font-mono"
              autoFocus
              disabled={cloning || checking}
              value={port}
              onChange={(event) => {
                setPort(event.target.value);
                forgetCheck();
              }}
              placeholder="ssl:perforce.example.com:1666"
            />
          </div>
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="p4-user">User</Label>
              <Input
                id="p4-user"
                className="font-mono"
                disabled={cloning || checking}
                value={user}
                onChange={(event) => {
                  setUser(event.target.value);
                  forgetCheck();
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="p4-password">Password</Label>
              <Input
                id="p4-password"
                type="password"
                disabled={cloning || checking}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  forgetCheck();
                }}
                placeholder="Optional"
              />
            </div>
            <Button type="button" variant="outline" disabled={cloning || checking || !port.trim() || !user.trim()} onClick={() => void check()}>
              {checking ? <Loader2Icon className="animate-spin" /> : null}
              Check connection
            </Button>
          </div>
          {server ? <p className="text-xs text-muted-foreground">Connected to {server}</p> : null}
          <div className="grid gap-2">
            <Label>Client</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={cloning || !clients}
                  className="justify-between font-normal"
                >
                  <span className="min-w-0 truncate font-mono">
                    {selected ? selected.name : clients ? "Select a client" : "Check the connection first"}
                  </span>
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-(--radix-dropdown-menu-trigger-width)">
                {(clients ?? []).map((item) => (
                  <DropdownMenuItem key={item.name} onClick={() => setClient(item.name)}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono">{item.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {item.stream || item.root}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void startCreate()}>Create</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={cloning} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!selected || cloning}>
            {cloning ? <Loader2Icon className="animate-spin" /> : null}
            Open
          </Button>
        </DialogFooter>
      </form>
      <CreateClientDialog
        open={createOpen}
        auth={auth()}
        cloning={cloning}
        onOpenChange={setCreateOpen}
        onCreate={async (request) => {
          await mutation.run(async () => {
            setCloning(true);
            const id = beginActivity("Creating workspace", request.client);
            try {
              const connection = await p4Api.createWorkspace(request, id);
              await openPath(connection.root, "perforce");
              setCreateOpen(false);
              onOpenChange(false);
            } catch (error) {
              const message = errorMessage(error);
              toast.error(message === P4_LOGIN ? "Enter the password for this user and try again." : message);
            } finally {
              endActivity(id);
              setCloning(false);
            }
          });
        }}
      />
    </>
  );
}

interface CreateClientDialogProps {
  open: boolean;
  auth: P4Auth;
  cloning: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (request: { port: string; user: string; password: string; client: string; root: string; stream: string; depotPath: string; charset: string }) => Promise<void>;
}

function CreateClientDialog(props: CreateClientDialogProps) {
  return <Dialog open={props.open} onOpenChange={(next) => !props.cloning && props.onOpenChange(next)}>
    <DialogContent className="sm:max-w-lg">
      {props.open ? <CreateClientForm {...props} /> : null}
    </DialogContent>
  </Dialog>;
}

function CreateClientForm({ auth, cloning, onOpenChange, onCreate }: CreateClientDialogProps) {
  const [client, setClient] = useState("");
  const [mapping, setMapping] = useState<"stream" | "depot">("stream");
  const [stream, setStream] = useState("");
  const [streamQuery, setStreamQuery] = useState("");
  const [depotPath, setDepotPath] = useState("");
  const [depotOpen, setDepotOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [retry, setRetry] = useState(0);
  const [request] = useState(createLatestRequest);
  const { port, user, password, charset } = auth;
  const scope = useMemo(() => ({ auth: { port, user, password, charset }, retry }), [port, user, password, charset, retry]);
  const [streamResult, setStreamResult] = useState<{ scope: typeof scope; streams: P4StreamOption[] | null; error: string | null } | null>(null);
  useEffect(() => {
    return request.run(() => p4Api.listStreams(scope.auth),
      (streams) => setStreamResult({ scope, streams, error: null }),
      (error) => setStreamResult({ scope, streams: null, error: errorMessage(error) }));
  }, [request, scope]);
  const currentStreams = streamResult?.scope === scope ? streamResult : null;
  const streams = currentStreams?.streams ?? null;
  const target = mapping === "stream" ? stream.trim() : depotPath.trim();
  const canCreate = isClientName(client) && isDepotPath(target) && isAbsolutePath(root) && !cloning;
  const visibleStreams = (streams ?? [])
    .filter((item) => item.path.toLowerCase().includes(streamQuery.trim().toLowerCase()))
    .slice(0, 80);

  async function browse() {
    const selected = await open({ directory: true, multiple: false, title: "Choose workspace root" });
    if (typeof selected === "string") setRoot(selected);
  }

  return (
    <>
        <DialogHeader>
          <DialogTitle>Create client</DialogTitle>
          <DialogDescription>Creates a client, syncs it, and opens the workspace.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="new-p4-client">Client name</Label>
            <Input
              id="new-p4-client"
              className="font-mono"
              autoFocus
              disabled={cloning}
              value={client}
              onChange={(event) => setClient(event.target.value)}
              placeholder="user_workspace"
            />
          </div>
          <div className="grid gap-2">
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mapping === "stream"} disabled={cloning} onChange={() => setMapping("stream")} />
                Stream
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mapping === "depot"} disabled={cloning} onChange={() => setMapping("depot")} />
                Depot path
              </label>
            </div>
            {mapping === "stream" ? (
              <div className="grid gap-2">
                <Input
                  className="font-mono"
                  disabled={cloning}
                  value={streamQuery}
                  onChange={(event) => setStreamQuery(event.target.value)}
                  placeholder={streams ? "Filter streams" : "Loading streams"}
                />
                <div className="max-h-40 overflow-auto rounded-md border">
                  {currentStreams?.error ? (
                    <div role="alert" className="grid gap-2 px-3 py-2 text-xs text-destructive"><p className="break-words">{currentStreams.error}</p><Button variant="outline" size="xs" className="w-fit" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div>
                  ) : streams === null ? (
                    <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading streams…</p>
                  ) : visibleStreams.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No matching streams</p>
                  ) : (
                    visibleStreams.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/70 ${stream === item.path ? "bg-muted" : ""}`}
                        onClick={() => setStream(item.path)}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono">{item.path}</span>
                        {item.kind ? <span className="shrink-0 text-muted-foreground">{item.kind}</span> : null}
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" className="justify-start font-mono font-normal" disabled={cloning} onClick={() => setDepotOpen(true)}>
                <span className="truncate">{depotPath || "Choose depot path"}</span>
              </Button>
            )}
          </div>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="new-p4-root">Local root</Label>
            <div className="flex min-w-0 gap-2">
              <Input
                id="new-p4-root"
                className="min-w-0 font-mono"
                disabled={cloning}
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                placeholder="C:\work\client"
              />
              <Button type="button" variant="outline" disabled={cloning} onClick={() => void browse()}>
                <FolderOpenIcon data-icon="inline-start" />
                Browse
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={cloning} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canCreate}
            onClick={() =>
              void onCreate({
                ...auth,
                client: client.trim(),
                root: root.trim(),
                stream: mapping === "stream" ? stream.trim() : "",
                depotPath: mapping === "depot" ? depotPath.trim() : "",
              })
            }
          >
            {cloning ? <Loader2Icon className="animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
        <DepotPicker
          open={depotOpen}
          auth={auth}
          onOpenChange={setDepotOpen}
          onPick={(path) => {
            setDepotPath(path);
            setDepotOpen(false);
          }}
        />
    </>
  );
}

function DepotPicker({ open: isOpen, auth, onOpenChange, onPick }: {
  open: boolean;
  auth: P4Auth;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  return <Dialog open={isOpen} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      {isOpen ? <DepotPickerForm auth={auth} onClose={() => onOpenChange(false)} onPick={onPick} /> : null}
    </DialogContent>
  </Dialog>;
}

function DepotPickerForm({ auth, onClose, onPick }: {
  auth: P4Auth;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState("//");
  const [retry, setRetry] = useState(0);
  const [request] = useState(createLatestRequest);
  const { port, user, password, charset } = auth;
  const scope = useMemo(() => ({ auth: { port, user, password, charset }, path, retry }), [port, user, password, charset, path, retry]);
  const [result, setResult] = useState<{ scope: typeof scope; entries: P4DepotEntry[] | null; error: string | null } | null>(null);
  useEffect(() => request.run(
    () => p4Api.listDepotDirs(scope.auth, scope.path === "//" ? "" : scope.path),
    (entries) => setResult({ scope, entries, error: null }),
    (error) => setResult({ scope, entries: null, error: errorMessage(error) }),
  ), [request, scope]);
  const current = result?.scope === scope ? result : null;
  const parent = depotParent(path);

  return <>
    <DialogHeader>
      <DialogTitle>Depot path</DialogTitle>
      <DialogDescription className="truncate font-mono">{path}</DialogDescription>
    </DialogHeader>
    <div className="max-h-72 overflow-auto rounded-md border">
      {parent ? <Button variant="ghost" className="w-full justify-start rounded-none font-mono font-normal" onClick={() => setPath(parent)}>..</Button> : null}
      {current?.error ? (
        <div role="alert" className="grid gap-2 px-3 py-2 text-xs text-destructive"><p className="break-words">{current.error}</p><Button variant="outline" size="xs" className="w-fit" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div>
      ) : current?.entries === undefined || current.entries === null ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading depot folders…</p>
      ) : current.entries.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No subfolders</p>
      ) : current.entries.map((entry) => (
        <Button key={entry.path} variant="ghost" className="w-full justify-start rounded-none font-mono text-xs font-normal" onClick={() => setPath(entry.path)}><span className="truncate">{entry.path}</span></Button>
      ))}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button disabled={path === "//" || !current?.entries || Boolean(current.error)} onClick={() => onPick(path)}>Use this path</Button>
    </DialogFooter>
  </>;
}

function depotParent(path: string) {
  if (!path || path === "//") return null;
  const slash = path.lastIndexOf("/");
  if (slash <= 1) return "//";
  return path.slice(0, slash);
}

function isClientName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/[\s\\/]/.test(trimmed);
}

function isDepotPath(value: string) {
  return /^\/\/\S+$/.test(value);
}

function isAbsolutePath(path: string) {
  const value = path.trim();
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}
