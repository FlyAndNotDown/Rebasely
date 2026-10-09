import { useEffect, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
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
import { useGitPick } from "@/state/git-context";

export function RepoSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot } = useGitPick(["snapshot"]);
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
        setName(localIdentity.name.trim() ? localIdentity.name : globalIdentity.name);
        setEmail(localIdentity.email.trim() ? localIdentity.email : globalIdentity.email);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, [open, repoPath]);

  async function save() {
    if (!repoPath) return;
    setSaving(true);
    try {
      const nextName = name.trim();
      const nextEmail = email.trim();
      await gitApi.setLocalGitIdentity(repoPath, {
        name: nextName === globalName.trim() ? "" : nextName,
        email: nextEmail === globalEmail.trim() ? "" : nextEmail,
      });
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repository Settings</DialogTitle>
          <DialogDescription>
            Starts from your global Git identity. A change is stored in this repository&apos;s{" "}
            <span className="font-mono">.git/config</span>. Reset puts the global value back.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <IdentityField
            id="repo-git-name"
            label="User name"
            value={name}
            fallback={globalName}
            onChange={setName}
          />
          <IdentityField
            id="repo-git-email"
            label="Email"
            type="email"
            value={email}
            fallback={globalEmail}
            onChange={setEmail}
          />
        </div>
        <DialogFooter>
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

function IdentityField({
  id,
  label,
  type = "text",
  value,
  fallback,
  onChange,
}: {
  id: string;
  label: string;
  type?: "text" | "email";
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const changed = value.trim() !== fallback.trim();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
        {changed ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label={`Reset ${label.toLowerCase()}`}
            title="Reset to repository default"
            onClick={() => onChange(fallback)}
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
