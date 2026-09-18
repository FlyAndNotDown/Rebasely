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

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void gitApi
      .getGitIdentity()
      .then((identity) => {
        setName(identity.name);
        setEmail(identity.email);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, [open]);

  async function save() {
    setSaving(true);
    try {
      await gitApi.setGitIdentity({ name: name.trim(), email: email.trim() });
      toast.success("Saved Git identity");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <div className="flex gap-6">
          <aside className="w-32 shrink-0">
            <button
              type="button"
              className={cn("w-full rounded-md bg-muted px-2 py-1.5 text-left text-sm")}
            >
              Git
            </button>
          </aside>
          <div className="min-w-0 flex-1">
            <DialogHeader>
              <DialogTitle>Git</DialogTitle>
              <DialogDescription>
                Global Git identity from your user Git config.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="git-name">User name</Label>
                <Input
                  id="git-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="git-email">Email</Label>
                <Input
                  id="git-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
