import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, FolderOpenIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { errorMessage } from "@/lib/git";
import { P4_LOGIN, p4Api } from "@/lib/p4";
import type { P4Auth, P4ClientOption, P4DepotEntry, P4StreamOption } from "@/types/p4";
import { useGitPick } from "@/state/git-context";

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
      <DialogContent className="sm:max-w-xl">
        {/* The form unmounts when the dialog closes, so every open starts empty. */}
        <CloneForm cloning={cloning} setCloning={setCloning} onOpenChange={onOpenChange} />
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
      <div className="mb-4 flex w-fit rounded-md bg-muted p-0.5">
        <Button
          type="button"
          size="sm"
          variant={kind === "git" ? "secondary" : "ghost"}
          className="h-7 px-3"
          disabled={cloning}
          onClick={() => setKind("git")}
        >
          Git
        </Button>
        <Button
          type="button"
          size="sm"
          variant={kind === "perforce" ? "secondary" : "ghost"}
          className="h-7 px-3"
          disabled={cloning}
          onClick={() => setKind("perforce")}
        >
          Perforce
        </Button>
      </div>
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
    setCloning(true);
    const ok = await cloneRepository(url.trim(), destination);
    setCloning(false);
    if (ok) onOpenChange(false);
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
            <Input
              id="clone-parent"
              className="min-w-0 font-mono"
              readOnly
              value={parent}
              placeholder="Choose a parent folder"
              title={parent}
            />
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
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={destination}>
              {destination}
            </p>
          ) : null}
        </div>
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" disabled={cloning} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canClone}>
          {cloning ? <Loader2Icon className="animate-spin" /> : null}
          Clone
        </Button>
      </DialogFooter>
    </form>
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
  const [streams, setStreams] = useState<P4StreamOption[] | null>(null);

  function forgetCheck() {
    setServer("");
    setClients(null);
    setClient("");
    setStreams(null);
  }

  function auth(): P4Auth {
    return { port: port.trim(), user: user.trim(), password, charset: prefs.p4Charset };
  }

  const selected = clients?.find((item) => item.name === client) ?? null;

  async function check() {
    if (!port.trim() || !user.trim() || checking) return;
    setChecking(true);
    forgetCheck();
    try {
      const checked = await p4Api.checkConnection(auth());
      setServer(checked.server);
      setClients(checked.clients);
      void updatePrefs({ ...prefs, p4Port: port.trim(), p4User: user.trim() });
    } catch (error) {
      const message = errorMessage(error);
      toast.error(message === P4_LOGIN ? "Enter the password for this user and try again." : message);
    } finally {
      setChecking(false);
    }
  }

  async function openClient() {
    if (!selected || cloning) return;
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
  }

  async function startCreate() {
    setCreateOpen(true);
    if (streams) return;
    try {
      setStreams(await p4Api.listStreams(auth()));
    } catch (error) {
      setStreams([]);
      toast.error(errorMessage(error));
    }
  }

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
        streams={streams}
        cloning={cloning}
        onOpenChange={setCreateOpen}
        onCreate={async (request) => {
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
        }}
      />
    </>
  );
}

function CreateClientDialog({
  open: isOpen,
  auth,
  streams,
  cloning,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  auth: P4Auth;
  streams: P4StreamOption[] | null;
  cloning: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (request: {
    port: string;
    user: string;
    password: string;
    client: string;
    root: string;
    stream: string;
    depotPath: string;
    charset: string;
  }) => Promise<void>;
}) {
  const [client, setClient] = useState("");
  const [mapping, setMapping] = useState<"stream" | "depot">("stream");
  const [stream, setStream] = useState("");
  const [streamQuery, setStreamQuery] = useState("");
  const [depotPath, setDepotPath] = useState("");
  const [depotOpen, setDepotOpen] = useState(false);
  const [root, setRoot] = useState("");
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
    <Dialog open={isOpen} onOpenChange={(next) => !cloning && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
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
                  {streams === null ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">Loading streams</p>
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
      </DialogContent>
    </Dialog>
  );
}

function DepotPicker({
  open: isOpen,
  auth,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  auth: P4Auth;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState("//");
  const [entries, setEntries] = useState<P4DepotEntry[] | null>(null);
  const [loaded, setLoaded] = useState("");
  if (isOpen && loaded !== path) {
    setLoaded(path);
    setEntries(null);
    void p4Api
      .listDepotDirs(auth, path === "//" ? "" : path)
      .then((next) => {
        setEntries(next);
      })
      .catch((error) => {
        setEntries([]);
        toast.error(errorMessage(error));
      });
  }
  if (!isOpen && loaded) {
    setLoaded("");
    setPath("//");
    setEntries(null);
  }
  const parent = depotParent(path);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Depot path</DialogTitle>
          <DialogDescription className="truncate font-mono">{path === "//" ? "//" : path}</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-auto rounded-md border">
          {parent ? (
            <button type="button" className="block w-full px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/70" onClick={() => setPath(parent)}>
              ..
            </button>
          ) : null}
          {entries === null ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/70"
                onClick={() => setPath(entry.path)}
              >
                {entry.path}
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={path === "//"} onClick={() => onPick(path)}>
            Use this path
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
