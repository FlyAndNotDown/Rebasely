import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowDownToLineIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { version } from "../../package.json";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { updateBusy, type UpdateSnapshot } from "@/state/app-updates";
import { appUpdates, useAppUpdates } from "@/state/use-app-updates";

function versionLabel(value: string) {
  return `v${value.replace(/^v/, "")}`;
}

function statusLabel(state: UpdateSnapshot) {
  if (state.request === "restart") return "Restarting Rebasely…";
  if (state.request === "check" || state.status === "checking") return "Checking for updates…";
  switch (state.status) {
    case "current": return "You are up to date.";
    case "available": return `${versionLabel(state.update?.version ?? "")} is available.`;
    case "downloading": {
      const downloaded = (state.downloadedBytes / 1_048_576).toFixed(1);
      return state.totalBytes
        ? `Downloading update: ${downloaded} / ${(state.totalBytes / 1_048_576).toFixed(1)} MB`
        : `Downloading update: ${downloaded} MB`;
    }
    case "installing": return "Installing update. Rebasely may close to finish installation.";
    case "installed": return "Update installed. Restart Rebasely when your work is saved.";
    case "error": return "The update could not be completed.";
    default: return state.request === "install" ? "Preparing update…" : "Check for a new version.";
  }
}

export function AppUpdateBanner() {
  const state = useAppUpdates();
  useEffect(() => {
    if (isTauri()) void appUpdates.start();
  }, []);
  useEffect(() => {
    const notice = state.notice;
    if (!notice) return;
    if (notice.kind === "available") {
      toast(`Rebasely ${versionLabel(notice.version)} is available`, {
        id: "app-update", duration: Infinity,
        action: { label: "Update", onClick: () => { void appUpdates.install(notice.version); } },
        cancel: { label: "Later", onClick: () => {} },
      });
    } else if (notice.kind === "installed") {
      toast.success("Update installed", {
        id: "app-update", duration: Infinity, description: "Restart when your work is saved.",
        action: { label: "Restart", onClick: () => { void appUpdates.restart(); } },
        cancel: { label: "Later", onClick: () => {} },
      });
    } else {
      toast.error("Update could not be completed", {
        id: "app-update", description: notice.message, duration: 10_000,
        action: { label: "Retry", onClick: () => {
          const current = appUpdates.getSnapshot();
          if (notice.request === "restart") void appUpdates.restart();
          else if (notice.request === "install" && current.update) void appUpdates.install(current.update.version);
          else void appUpdates.check();
        } },
      });
    }
    appUpdates.dismissNotice(notice.id);
  }, [state.notice]);
  useEffect(() => {
    if (state.request === "install" || state.status === "downloading" || state.status === "installing") {
      toast.dismiss("app-update");
      toast.loading(statusLabel(state), { id: "app-update-progress", duration: Infinity });
    } else {
      toast.dismiss("app-update-progress");
      if (state.request === "check" || state.status === "checking") toast.dismiss("app-update");
    }
  }, [state]);
  return null;
}

export function UpdatesSettings() {
  const state = useAppUpdates();
  const busy = updateBusy(state);
  const update = state.update;
  const canInstall = update && ["available", "error"].includes(state.status);
  const percent = state.totalBytes && state.totalBytes > 0
    ? Math.min(100, Math.max(0, 100 * state.downloadedBytes / state.totalBytes))
    : null;
  return (
    <section aria-labelledby="updates-title" className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="updates-title" className="text-sm font-medium">Application updates</h3>
          <p className="mt-1 text-xs text-muted-foreground">Installed version {versionLabel(version)}</p>
        </div>
        <HoverTip label="Checks at startup. Check again at any time.">
        <Button variant="outline" size="sm" disabled={busy || state.status === "installed"} onClick={() => void appUpdates.check()}>
          <RefreshCwIcon className={state.request === "check" || state.status === "checking" ? "motion-safe:animate-spin" : ""} />
          {state.request === "check" || state.status === "checking" ? "Checking…" : "Check for updates"}
        </Button>
        </HoverTip>
      </div>
      <div role={state.status === "error" ? "alert" : "status"} className="grid gap-2 text-sm">
        <p className={state.status === "error" ? "text-destructive" : "text-muted-foreground"}>
          {state.status === "current" ? <CheckIcon className="mr-1.5 inline size-3.5" /> : null}
          {statusLabel(state)}
        </p>
        {state.error ? (
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">Details</summary>
            <p className="mt-2 break-words">{state.error}</p>
          </details>
        ) : null}
        {state.status === "error" ? <p className="text-xs text-muted-foreground">Check your connection and try again.</p> : null}
        {state.status === "downloading" ? (
          <div
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full rounded-full bg-primary ${percent === null ? "motion-safe:animate-pulse" : ""}`}
              style={{ width: `${percent ?? 100}%` }}
            />
          </div>
        ) : null}
      </div>
      {update?.notes ? (
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">Release notes</summary>
          <ScrollArea className="mt-2 rounded-md border bg-muted/30" viewportClassName="max-h-32" scrollbars="vertical">
            <p className="whitespace-pre-wrap break-words p-3 text-xs">{update.notes}</p>
          </ScrollArea>
        </details>
      ) : null}
      {canInstall ? (
        <div><Button size="sm" disabled={busy} onClick={() => void appUpdates.install(update.version)}><ArrowDownToLineIcon />Update to {versionLabel(update.version)}</Button></div>
      ) : null}
      {state.status === "installed" ? (
        <div><Button size="sm" disabled={busy} onClick={() => void appUpdates.restart()}>Restart Rebasely</Button></div>
      ) : null}
    </section>
  );
}
