import { useRef, useState } from "react";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon, InfoIcon, Loader2Icon } from "lucide-react";
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
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage, GIT_MISSING, gitApi } from "@/lib/git";
import { useGitPick } from "@/state/git-context";

export function InitializeRepositoryDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <InitializeForm onOpenChange={onOpenChange} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function InitializeForm({ onOpenChange, onBusyChange }: {
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { openPath, setOpenPanel } = useGitPick(["openPath", "setOpenPanel"]);
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("main");
  const [activity, setActivity] = useState<"browse" | "initialize" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const busy = activity !== null;

  function start(next: "browse" | "initialize") {
    if (pending.current) return false;
    pending.current = true;
    setActivity(next);
    onBusyChange(true);
    setError(null);
    return true;
  }

  function finish() {
    pending.current = false;
    setActivity(null);
    onBusyChange(false);
  }

  async function browse() {
    if (!start("browse")) return;
    try {
      const selected = await chooseFolder({
        directory: true,
        multiple: false,
        title: "Choose a folder to initialize",
      });
      if (typeof selected === "string") setPath(selected);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  async function initialize() {
    if (!path.trim() || !branch.trim() || !start("initialize")) return;
    try {
      const initialized = await gitApi.initializeRepository(path, branch.trim());
      onOpenChange(false);
      void openPath(initialized, "git");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  return (
    <form aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void initialize(); }}>
      <DialogHeader>
        <DialogTitle>Initialize Git repository</DialogTitle>
        <DialogDescription>Create a Git repository in an existing folder.</DialogDescription>
      </DialogHeader>
      <p role="status" className="sr-only">{activity === "initialize" ? "Initializing repository." : activity === "browse" ? "Choosing a folder." : ""}</p>
      <div className="my-4 grid gap-4">
        <div className="grid gap-2">
          <div className="flex items-center gap-1">
            <Label htmlFor="initialize-path">Folder</Label>
            <HoverTip label="Choose a folder outside an existing Git worktree. Its files are left unstaged.">
              <Button variant="ghost" size="icon-xs" aria-label="Initialization scope"><InfoIcon /></Button>
            </HoverTip>
          </div>
          <div className="flex min-w-0 gap-2">
            <Input
              id="initialize-path"
              className="min-w-0 font-mono"
              autoFocus
              value={path}
              disabled={busy}
              placeholder="Absolute folder path"
              aria-describedby={error ? "initialize-error" : undefined}
              onChange={(event) => { setPath(event.target.value); setError(null); }}
            />
            <Button variant="outline" disabled={busy} onClick={() => void browse()}>
              <FolderOpenIcon />
              {activity === "browse" ? "Choosing" : "Browse"}
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="initialize-branch">Initial branch</Label>
          <Input
            id="initialize-branch"
            className="font-mono"
            value={branch}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={error ? "initialize-error" : undefined}
            onChange={(event) => { setBranch(event.target.value); setError(null); }}
          />
        </div>
        {error ? (
          <div id="initialize-error" role="alert" className="grid gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <p className="break-words whitespace-pre-wrap">{error}</p>
            {error === GIT_MISSING ? <Button variant="outline" size="sm" className="w-fit" onClick={() => { onOpenChange(false); setOpenPanel("settings"); }}>Open Settings</Button> : null}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" disabled={busy || !path.trim() || !branch.trim()}>
          {activity === "initialize" ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}
          {activity === "initialize" ? "Initializing" : "Initialize"}
        </Button>
      </DialogFooter>
    </form>
  );
}
