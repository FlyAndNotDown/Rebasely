import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
      <DialogContent className="sm:max-w-md">
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
        <DialogTitle>Clone repository</DialogTitle>
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
  const { prefs, openPath, beginActivity, endActivity } = useGitPick([
    "prefs",
    "openPath",
    "beginActivity",
    "endActivity",
  ]);
  const [port, setPort] = useState(prefs.p4Port);
  const [user, setUser] = useState(prefs.p4User);
  const [password, setPassword] = useState("");
  const [client, setClient] = useState("");
  const [mapping, setMapping] = useState<"stream" | "depot">("stream");
  const [stream, setStream] = useState("");
  const [depotPath, setDepotPath] = useState("");
  const [root, setRoot] = useState("");
  const target = mapping === "stream" ? stream.trim() : depotPath.trim();
  const canCreate =
    port.trim().length > 0 &&
    user.trim().length > 0 &&
    isClientName(client) &&
    isDepotPath(target) &&
    isAbsolutePath(root) &&
    !cloning;

  async function browse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose workspace root",
    });
    if (typeof selected === "string") setRoot(selected);
  }

  async function submit() {
    if (!canCreate) return;
    setCloning(true);
    const id = beginActivity("Creating workspace", client.trim());
    try {
      const connection = await p4Api.createWorkspace(
        {
          port: port.trim(),
          user: user.trim(),
          password,
          client: client.trim(),
          root: root.trim(),
          stream: mapping === "stream" ? stream.trim() : "",
          depotPath: mapping === "depot" ? depotPath.trim() : "",
          charset: prefs.p4Charset,
        },
        id,
      );
      await openPath(connection.root, "perforce");
      onOpenChange(false);
    } catch (error) {
      const message = errorMessage(error);
      if (message === P4_LOGIN) toast.error("Enter the password for this user and try again.");
      else toast.error(message);
    } finally {
      endActivity(id);
      setCloning(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription>
          Creates a Perforce client, writes a P4CONFIG file, syncs the server, and opens the workspace.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-3 grid min-w-0 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="p4-port">Server</Label>
          <Input
            id="p4-port"
            className="font-mono"
            autoFocus
            disabled={cloning}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            placeholder="ssl:perforce.example.com:1666"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="p4-user">User</Label>
            <Input
              id="p4-user"
              className="font-mono"
              disabled={cloning}
              value={user}
              onChange={(event) => setUser(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="p4-password">Password</Label>
            <Input
              id="p4-password"
              type="password"
              disabled={cloning}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="p4-client">Client name</Label>
          <Input
            id="p4-client"
            className="font-mono"
            disabled={cloning}
            value={client}
            onChange={(event) => setClient(event.target.value)}
            placeholder="user_workspace"
          />
        </div>
        <div className="grid gap-2">
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="p4-mapping"
                checked={mapping === "stream"}
                disabled={cloning}
                onChange={() => setMapping("stream")}
              />
              Stream
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="p4-mapping"
                checked={mapping === "depot"}
                disabled={cloning}
                onChange={() => setMapping("depot")}
              />
              Depot path
            </label>
          </div>
          {mapping === "stream" ? (
            <Input
              className="font-mono"
              disabled={cloning}
              value={stream}
              onChange={(event) => setStream(event.target.value)}
              placeholder="//depot/main"
            />
          ) : (
            <Input
              className="font-mono"
              disabled={cloning}
              value={depotPath}
              onChange={(event) => setDepotPath(event.target.value)}
              placeholder="//depot/project"
            />
          )}
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="p4-root">Local root</Label>
          <div className="flex min-w-0 gap-2">
            <Input
              id="p4-root"
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
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" disabled={cloning} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canCreate}>
          {cloning ? <Loader2Icon className="animate-spin" /> : null}
          Create workspace
        </Button>
      </DialogFooter>
    </form>
  );
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
