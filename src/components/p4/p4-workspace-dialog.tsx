import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Loader2Icon } from "lucide-react";
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
import { useP4 } from "@/state/p4-context";

export function P4WorkspaceDialog() {
  const { connection, workspaceOpen, setWorkspaceOpen, saveWorkspace } = useP4();
  const [root, setRoot] = useState("");
  const [stream, setStream] = useState("");
  const [saving, setSaving] = useState(false);
  const [seed, setSeed] = useState("");
  const nextSeed = workspaceOpen && connection ? `${connection.root}\n${connection.stream ?? ""}` : "";
  if (nextSeed !== seed) {
    setSeed(nextSeed);
    setRoot(connection?.root ?? "");
    setStream(connection?.stream ?? "");
    setSaving(false);
  }

  async function browse() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Workspace folder",
      defaultPath: root || undefined,
    });
    if (typeof picked === "string") setRoot(picked);
  }

  async function submit() {
    if (!root.trim() || saving) return;
    setSaving(true);
    try {
      await saveWorkspace(root.trim(), stream.trim());
      setWorkspaceOpen(false);
    } catch {
      // The workspace save already reports the error.
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={workspaceOpen} onOpenChange={(open) => !saving && setWorkspaceOpen(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit workspace</DialogTitle>
          <DialogDescription>Local folder and stream for {connection?.client || "this client"}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="edit-p4-root">Folder</Label>
            <div className="flex gap-2">
              <Input
                id="edit-p4-root"
                className="font-mono"
                value={root}
                spellCheck={false}
                onChange={(event) => setRoot(event.target.value)}
              />
              <Button type="button" variant="outline" disabled={saving} onClick={() => void browse()}>
                Browse
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-p4-stream">Stream</Label>
            <Input
              id="edit-p4-stream"
              className="font-mono"
              value={stream}
              placeholder="//depot/main"
              spellCheck={false}
              onChange={(event) => setStream(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Leave the stream empty for a classic client.</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => setWorkspaceOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving || !root.trim()} onClick={() => void submit()}>
            {saving ? <Loader2Icon className="animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
