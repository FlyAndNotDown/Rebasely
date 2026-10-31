import { formatNumber, t, useTranslation } from "@/i18n";
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
  if (state.request === "restart") return t("desktop.appUpdates.restarting_rebasely");
  if (state.request === "check" || state.status === "checking") return t("desktop.appUpdates.checking_for_updates");
  switch (state.status) {
    case "current": return t("desktop.appUpdates.you_are_up_to_date");
    case "available": return t("desktop.appUpdates.availableVersion", { version: versionLabel(state.update?.version ?? "") });
    case "downloading": {
      const downloaded = formatNumber(state.downloadedBytes / 1_048_576, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return state.totalBytes
        ? t("desktop.appUpdates.downloadingTotal", { downloaded, total: formatNumber(state.totalBytes / 1_048_576, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
        : t("desktop.appUpdates.downloading", { downloaded });
    }
    case "installing": return t("desktop.appUpdates.installing_update_rebasely_may_close_to_finish_installation");
    case "installed": return t("desktop.appUpdates.update_installed_restart_rebasely_when_your_work_is");
    case "error": return t("desktop.appUpdates.the_update_could_not_be_completed");
    default: return state.request === "install" ? t("desktop.appUpdates.preparing_update") : t("desktop.appUpdates.check_for_a_new_version");
  }
}

export function AppUpdateBanner() {
  useTranslation();
  const state = useAppUpdates();
  useEffect(() => {
    if (isTauri()) void appUpdates.start();
  }, []);
  useEffect(() => {
    const notice = state.notice;
    if (!notice) return;
    if (notice.kind === "available") {
      toast(t("desktop.appUpdates.availableNotice", { version: versionLabel(notice.version) }), {
        id: "app-update", duration: Infinity,
        action: { label: t("desktop.appUpdates.update"), onClick: () => { void appUpdates.install(notice.version); } },
        cancel: { label: t("desktop.appUpdates.later"), onClick: () => {} },
      });
    } else if (notice.kind === "installed") {
      toast.success(t("desktop.appUpdates.update_installed"), {
        id: "app-update", duration: Infinity, description: t("desktop.appUpdates.restart_when_your_work_is_saved"),
        action: { label: t("desktop.appUpdates.restart"), onClick: () => { void appUpdates.restart(); } },
        cancel: { label: t("desktop.appUpdates.later"), onClick: () => {} },
      });
    } else {
      toast.error(t("desktop.appUpdates.update_could_not_be_completed"), {
        id: "app-update", description: notice.message, duration: 10_000,
        action: { label: t("common.retry"), onClick: () => {
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
  useTranslation();
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
          <h3 id="updates-title" className="text-sm font-medium">{t("desktop.appUpdates.application_updates")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("desktop.appUpdates.installed_version")}{" "}{versionLabel(version)}</p>
        </div>
        <HoverTip label={t("desktop.appUpdates.checks_at_startup_check_again_at_any_time")}>
        <Button variant="outline" size="sm" disabled={busy || state.status === "installed"} onClick={() => void appUpdates.check()}>
          <RefreshCwIcon className={state.request === "check" || state.status === "checking" ? "motion-safe:animate-spin" : ""} />
          {state.request === "check" || state.status === "checking" ? t("desktop.appUpdates.checking") : t("desktop.appUpdates.check_for_updates")}
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
            <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">{t("desktop.appUpdates.details")}</summary>
            <p className="mt-2 break-words">{state.error}</p>
          </details>
        ) : null}
        {state.status === "error" ? <p className="text-xs text-muted-foreground">{t("desktop.appUpdates.check_your_connection_and_try_again")}</p> : null}
        {state.status === "downloading" ? (
          <div
            role="progressbar"
            aria-label={t("desktop.appUpdates.update_download")}
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
          <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">{t("desktop.appUpdates.release_notes")}</summary>
          <ScrollArea className="mt-2 rounded-md border bg-muted/30" viewportClassName="max-h-32" scrollbars="vertical">
            <p className="whitespace-pre-wrap break-words p-3 text-xs">{update.notes}</p>
          </ScrollArea>
        </details>
      ) : null}
      {canInstall ? (
        <div><Button size="sm" disabled={busy} onClick={() => void appUpdates.install(update.version)}><ArrowDownToLineIcon />{t("desktop.appUpdates.update_to")}{" "}{versionLabel(update.version)}</Button></div>
      ) : null}
      {state.status === "installed" ? (
        <div><Button size="sm" disabled={busy} onClick={() => void appUpdates.restart()}>{t("desktop.appUpdates.restart_rebasely")}</Button></div>
      ) : null}
    </section>
  );
}
