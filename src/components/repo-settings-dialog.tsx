import { useEffect, useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
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
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/git";
import { createRepositoryIdentitySession } from "@/lib/repository-identity";
import { useGitPick } from "@/state/git-context";
import type { GitIdentity } from "@/types/git";

export function RepoSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot } = useGitPick(["snapshot"]);
  const repoPath = snapshot?.repo.path;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repository settings</DialogTitle>
          <DialogDescription>
            {repoPath ? "Override your global Git identity for this repository." : "Open a repository to edit its identity."}
          </DialogDescription>
        </DialogHeader>
        {open && repoPath ? (
          <RepoSettingsForm key={repoPath} repoPath={repoPath} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RepoSettingsForm({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [globalIdentity, setGlobalIdentity] = useState<GitIdentity | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const session = useRef<ReturnType<typeof createRepositoryIdentitySession> | null>(null);

  useEffect(() => {
    const request = createRepositoryIdentitySession(repoPath);
    session.current = request;
    void request.load()
      .then((identity) => {
        if (!identity || session.current !== request) return;
        setGlobalIdentity(identity.global);
        setName(identity.value.name);
        setEmail(identity.value.email);
      })
      .catch((error: unknown) => {
        if (session.current === request) setError(errorMessage(error));
      });
    return () => {
      request.dispose();
      session.current = null;
    };
  }, [repoPath, reload]);

  async function save() {
    const request = session.current;
    if (!request || !globalIdentity || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await request.save({ name, email }, globalIdentity);
      if (!saved || session.current !== request) return;
      toast.success("Saved repository settings");
      onClose();
    } catch (error) {
      if (session.current === request) setError(errorMessage(error));
    } finally {
      if (session.current === request) setSaving(false);
    }
  }

  return (
    <>
      {error ? (
        <div role="alert" className="flex items-start gap-2">
          <p className="min-w-0 flex-1 break-words text-sm text-destructive">{error}</p>
          {!globalIdentity ? (
            <Button variant="outline" size="sm" onClick={() => { setError(""); setReload((value) => value + 1); }}>Retry</Button>
          ) : null}
        </div>
      ) : null}
      {globalIdentity ? (
        <div className="grid gap-5">
          <IdentityField
            id="repo-git-name"
            label="User name"
            value={name}
            fallback={globalIdentity.name}
            disabled={saving}
            onChange={setName}
          />
          <IdentityField
            id="repo-git-email"
            label="Email"
            type="email"
            value={email}
            fallback={globalIdentity.email}
            disabled={saving}
            onChange={setEmail}
          />
        </div>
      ) : !error ? (
        <div role="status" aria-label="Loading repository identity" className="grid gap-5">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving || !globalIdentity}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

function IdentityField({
  id,
  label,
  type = "text",
  value,
  fallback,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  type?: "text" | "email";
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const changed = value.trim() !== fallback.trim();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
        {changed ? (
          <HoverTip label="Use global identity">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={`Reset ${label.toLowerCase()}`}
              disabled={disabled}
              onClick={() => onChange(fallback)}
            >
              <RotateCcwIcon />
            </Button>
          </HoverTip>
        ) : null}
      </div>
    </div>
  );
}
