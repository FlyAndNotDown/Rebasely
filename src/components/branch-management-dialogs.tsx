import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, gitApi } from "@/lib/git";
import { createExclusiveAction } from "@/lib/async-scope";
import type { BranchInfo, RemoteInfo } from "@/types/git";

function useDialogSave(onDone: () => void) {
  const [mutation] = useState(createExclusiveAction);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  function save(action: () => Promise<boolean>) {
    void mutation.run(async () => {
      setBusy(true);
      setFailed(false);
      try {
        if (await action()) onDone();
        else setFailed(true);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    });
  }
  return { mutation, busy, failed, setFailed, save };
}

export function RenameBranchDialog({ branch, existingNames, onOpenChange, onRename }: {
  branch: BranchInfo;
  existingNames: string[];
  onOpenChange: (open: boolean) => void;
  onRename: (name: string, newName: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(branch.name);
  const { mutation, busy, failed, setFailed, save } = useDialogSave(() => onOpenChange(false));
  const next = name.trim();
  const taken = next !== branch.name && existingNames.includes(next);
  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.busy) onOpenChange(open); }}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!next || next === branch.name || taken || busy) return;
          save(() => onRename(branch.name, next));
        }}>
          <DialogHeader>
            <DialogTitle>{t("git.branch.renameTitle")}</DialogTitle>
            <DialogDescription>{t("git.branch.renameDescription", { name: branch.name })}</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-2">
            <Label htmlFor="rename-branch-name">{t("git.branch.newName")}</Label>
            <Input id="rename-branch-name" autoFocus className="font-mono" value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setFailed(false); }} />
            {taken ? <p role="alert" className="text-xs text-destructive">{t("git.branch.nameTaken", { name: next })}</p> : null}
            {failed ? <p role="alert" className="text-xs text-destructive">{t("git.branch.renameFailed")}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!next || next === branch.name || taken || busy}>
              {busy ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={busy ? "status" : undefined}>{t(busy ? "git.branch.renamingLabel" : "git.branch.rename")}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BranchUpstreamDialog({ branch, remoteBranches, onOpenChange, onSave }: {
  branch: BranchInfo;
  remoteBranches: BranchInfo[];
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, upstream: string | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [upstream, setUpstream] = useState(branch.upstream ?? "");
  const { mutation, busy, failed, setFailed, save } = useDialogSave(() => onOpenChange(false));
  const names = remoteBranches.map((item) => item.name);
  const missing = Boolean(upstream && !names.includes(upstream));
  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.busy) onOpenChange(open); }}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (busy || missing || upstream === (branch.upstream ?? "")) return;
          save(() => onSave(branch.name, upstream || null));
        }}>
          <DialogHeader>
            <DialogTitle>{t("git.branch.upstreamTitle")}</DialogTitle>
            <DialogDescription>{t("git.branch.upstreamDescription", { name: branch.name })}</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-2">
            <Label htmlFor="branch-upstream">{t("git.branch.upstream")}</Label>
            <select id="branch-upstream" autoFocus className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={upstream} disabled={busy} onChange={(event) => { setUpstream(event.target.value); setFailed(false); }}>
              <option value="">{t("git.branch.noUpstream")}</option>
              {missing ? <option value={upstream}>{upstream} {t("git.branch.missingUpstream")}</option> : null}
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            {names.length === 0 ? <p className="text-xs text-muted-foreground">{t("git.branch.noRemoteBranches")}</p> : null}
            {failed ? <p role="alert" className="text-xs text-destructive">{t("git.branch.upstreamFailed")}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy || missing || upstream === (branch.upstream ?? "")}>
              {busy ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={busy ? "status" : undefined}>{t(busy ? "git.branch.saving" : "common.save")}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditRemoteDialog({ remote, repoPath, onOpenChange, onSave }: {
  remote: RemoteInfo;
  repoPath: string;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, url: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(remote.url ?? "");
  const { mutation, busy, failed, setFailed, save } = useDialogSave(() => onOpenChange(false));
  const [probeAction] = useState(createExclusiveAction);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const next = url.trim();
  async function test() {
    if (!next || mutation.busy) return;
    await probeAction.run(async () => {
      setTesting(true);
      setProbe(null);
      try {
        const result = await gitApi.probeRemoteUrl(repoPath, next);
        setProbe({ ok: true, message: t("git.remote.reachable", { count: result.heads }) });
      } catch (error) {
        setProbe({ ok: false, message: errorMessage(error) });
      } finally {
        setTesting(false);
      }
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.busy) onOpenChange(open); }}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!next || next === remote.url || busy || probeAction.busy) return;
          save(() => onSave(remote.name, next));
        }}>
          <DialogHeader>
            <DialogTitle>{t("git.remote.editTitle", { name: remote.name })}</DialogTitle>
            <DialogDescription>{t("git.remote.editDescription")}</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-2">
            <Label htmlFor="edit-remote-url">{t("git.remote.url")}</Label>
            <Input id="edit-remote-url" autoFocus className="font-mono" value={url} disabled={busy || testing} onChange={(event) => { setUrl(event.target.value); setProbe(null); setFailed(false); }} />
            {remote.pushUrl && remote.pushUrl !== remote.url ? <p className="break-all text-xs text-muted-foreground">{t("git.remote.explicitPushUrl", { url: remote.pushUrl })}</p> : null}
            {probe ? <p role={probe.ok ? "status" : "alert"} className={probe.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{probe.message}</p> : null}
            {failed ? <p role="alert" className="text-xs text-destructive">{t("git.remote.saveFailed")}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" className="sm:mr-auto" disabled={!next || busy || testing} onClick={() => void test()}>
              {testing ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={testing ? "status" : undefined}>{t(testing ? "git.remote.testing" : "git.remote.test")}</span>
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!next || next === remote.url || busy || testing}>
              {busy ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={busy ? "status" : undefined}>{t(busy ? "git.branch.saving" : "common.save")}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
