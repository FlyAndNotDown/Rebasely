import { t, useTranslation } from "@/i18n";
import { useState } from "react";
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
import { errorMessage, gitApi } from "@/lib/git";
import { useGitSelect } from "@/state/git-context";

type AddRemoteProps = {
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onAdd: (name: string, url: string) => Promise<boolean>;
};

export function AddRemoteDialog({ open, ...props }: AddRemoteProps & { open: boolean }) {
  useTranslation();
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* The form unmounts when the dialog closes, so every open starts fresh. */}
        <AddRemoteForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function AddRemoteForm({ onOpenChange, existingNames, onAdd }: AddRemoteProps) {
  useTranslation();
  const repoPath = useGitSelect((state) => state.snapshot?.repo.path);
  const [name, setName] = useState(() =>
    existingNames.some((item) => item.toLowerCase() === "origin") ? "" : "origin",
  );
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const taken = existingNames.some((item) => item.toLowerCase() === trimmedName.toLowerCase());
  const canSubmit = Boolean(repoPath && trimmedName && trimmedUrl && !taken && !saving && !testing);

  async function testConnection() {
    if (!repoPath || !trimmedUrl) return;
    setTesting(true);
    setProbe(null);
    try {
      const result = await gitApi.probeRemoteUrl(repoPath, trimmedUrl);
      setProbe({
        ok: true,
        message: t("git.remote.reachable", { count: result.heads }),
      });
    } catch (error) {
      setProbe({ ok: false, message: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const ok = await onAdd(trimmedName, trimmedUrl);
      if (ok) onOpenChange(false);
    } finally {
      setSaving(false);
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
        <DialogTitle>{t("git.ui.add_remote")}</DialogTitle>
        <DialogDescription>{t("git.ui.adds_a_remote_to_this_repository_then_fetches_its_branches")}</DialogDescription>
      </DialogHeader>
      <div className="mt-3 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="add-remote-name">{t("git.ui.name")}</Label>
          <Input
            id="add-remote-name"
            className="font-mono"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("git.dynamic.remoteExample")}
          />
          {taken ? (
            <p role="alert" className="text-xs text-destructive">{t("git.dynamic.remoteExists", { name: trimmedName })}</p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="add-remote-url">{t("git.ui.url")}</Label>
          <Input
            id="add-remote-url"
            className="font-mono"
            value={url}
            disabled={testing || saving}
            onChange={(event) => {
              setUrl(event.target.value);
              setProbe(null);
            }}
            placeholder="https://github.com/org/repo.git"
          />
        </div>
        {probe ? (
          <p role={probe.ok ? "status" : "alert"} className={probe.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
            {probe.message}
          </p>
        ) : null}
      </div>
      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="outline"
          className="sm:mr-auto"
          disabled={!repoPath || !trimmedUrl || testing || saving}
          onClick={() => void testConnection()}
        >
          {testing ? <Loader2Icon className="animate-spin" /> : null}{t("git.ui.test_connection")}</Button>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("git.ui.cancel")}</Button>
        <Button type="submit" disabled={!canSubmit}>
          {saving ? <Loader2Icon className="animate-spin" /> : null}{t("git.ui.add")}</Button>
      </DialogFooter>
    </form>
  );
}
