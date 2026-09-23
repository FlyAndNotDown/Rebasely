import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
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
import { useGit } from "@/state/git-context";

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
  const { cloneRepository } = useGit();
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setUrl("");
    setParent("");
    setFolder("");
    setFolderEdited(false);
    setCloning(false);
  }, [isOpen]);

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
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (cloning) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
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
      </DialogContent>
    </Dialog>
  );
}
