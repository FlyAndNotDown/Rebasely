import { useEffect, useState } from "react";
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
import { errorMessage, gitApi } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function RepoSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot } = useGit();
  const repoPath = snapshot?.repo.path;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [globalName, setGlobalName] = useState("");
  const [globalEmail, setGlobalEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !repoPath) return;
    void Promise.all([gitApi.getGitIdentity(), gitApi.getLocalGitIdentity(repoPath)])
      .then(([globalIdentity, localIdentity]) => {
        setGlobalName(globalIdentity.name);
        setGlobalEmail(globalIdentity.email);
        setName(localIdentity.name);
        setEmail(localIdentity.email);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, [open, repoPath]);

  async function save() {
    if (!repoPath) return;
    setSaving(true);
    try {
      await gitApi.setLocalGitIdentity(repoPath, { name: name.trim(), email: email.trim() });
      toast.success("Saved repository settings");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none">
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-44 shrink-0 flex-col gap-1 border-r p-4">
            <button
              type="button"
              className={cn("w-full rounded-md bg-muted px-2.5 py-1.5 text-left text-sm text-foreground")}
            >
              Git config
            </button>
          </aside>
          <div className="min-w-0 flex-1 overflow-auto p-6">
            <DialogHeader>
              <DialogTitle>Git config</DialogTitle>
              <DialogDescription>
                Local identity for this repository, written to <span className="font-mono">.git/config</span>.
                Blank fields inherit the global Git config.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-6 grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="repo-git-name">User name</Label>
                <Input
                  id="repo-git-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={globalName || "Use global name"}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="repo-git-email">Email</Label>
                <Input
                  id="repo-git-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={globalEmail || "Use global email"}
                />
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="mx-0 mb-0 rounded-none">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving || !repoPath}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
