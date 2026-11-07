import { formatNumber, t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ArrowDownToLineIcon, CheckIcon, RefreshCwIcon, RotateCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { updateBusy, type UpdateSnapshot } from "@/state/app-updates";
import { appUpdates, useAppUpdates } from "@/state/use-app-updates";
import { errorMessage, gitApi } from "@/lib/git";

type NotesRenderer = typeof import("@/components/release-notes").default;
let cachedNotesRenderer: NotesRenderer | null = null;

function openReleaseNoteLink(url: string) {
  void gitApi.openExternalUrl(url).catch((error: unknown) => toast.error(errorMessage(error)));
}

function versionLabel(value: string) {
  return `v${value.replace(/^v/, "")}`;
}

function statusLabel(state: UpdateSnapshot) {
  if (state.request === "restart") return t("desktop.appUpdates.restarting_rebaseraven");
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
    case "installing": return t("desktop.appUpdates.installing_update_rebaseraven_may_close_to_finish_installation");
    case "installed": return t("desktop.appUpdates.update_installed_restart_rebaseraven_when_your_work_is");
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
  const state = useAppUpdates();
  return <UpdatesSettingsView state={state} onCheck={() => void appUpdates.check()} onInstall={(version) => void appUpdates.install(version)} onRestart={() => void appUpdates.restart()} />;
}

export function UpdatesSettingsView({ state, onCheck, onInstall, onRestart }: {
  state: UpdateSnapshot;
  onCheck: () => void;
  onInstall: (version: string) => void;
  onRestart: () => void;
}) {
  useTranslation();
  const busy = updateBusy(state);
  const update = state.update;
  const canInstall = update && ["available", "error"].includes(state.status);
  const percent = state.totalBytes && state.totalBytes > 0
    ? Math.min(100, Math.max(0, 100 * state.downloadedBytes / state.totalBytes))
    : null;
  const checking = state.request === "check" || state.status === "checking";
  const checkFailed = state.status === "error" && (state.lastRequest === "check" || !state.update);
  const checkSucceeded = !checking && state.lastRequest === "check" && !state.error && ["current", "available"].includes(state.status);
  const checkFeedback = checking ? t("desktop.appUpdates.checking_for_updates")
    : checkFailed ? state.error || t("desktop.appUpdates.the_update_could_not_be_completed")
    : checkSucceeded ? statusLabel(state) : null;
  const hasUpdateWorkflow = ["downloading", "installing", "installed"].includes(state.status) || state.request === "install" || state.request === "restart";
  const workflowLabel = state.request === "install" && state.status === "available"
    ? t("desktop.appUpdates.preparing_update") : statusLabel(state);
  const installFailed = state.status === "error" && state.lastRequest === "install";
  const restartFailed = state.status === "installed" && !!state.error && state.lastRequest === "restart";
  return (
    <section aria-labelledby="updates-title" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="updates-title" className="text-sm font-medium">{t("desktop.appUpdates.application_updates")}</h3>
        <HoverTip label={checkFeedback ?? t("desktop.appUpdates.checks_at_startup_check_again_at_any_time")}>
          <span className="inline-flex">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || state.status === "installed"}
              aria-busy={checking}
              aria-label={checkFeedback ? `${t("desktop.appUpdates.check_for_updates")}: ${checkFeedback}` : undefined}
              onClick={onCheck}
            >
              <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                {checking ? <RefreshCwIcon className="motion-safe:animate-spin" /> : checkFailed ? <XIcon className="text-destructive" /> : checkSucceeded ? <CheckIcon /> : <RefreshCwIcon />}
              </span>
              {t("desktop.appUpdates.check_for_updates")}
            </Button>
          </span>
        </HoverTip>
      </div>
      <span role="status" className="sr-only">{checkFeedback}</span>
      {hasUpdateWorkflow ? (
        <div role="status" className="grid gap-2 text-sm text-muted-foreground">
          <p>{workflowLabel}</p>
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
      ) : null}
      {update ? (
        <div className="grid min-w-0 gap-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <p className="text-xs text-muted-foreground">{t("desktop.appUpdates.latest_version")}</p>
              <h4 className="text-lg leading-6 font-medium tracking-tight">{versionLabel(update.version)}</h4>
            </div>
            {canInstall ? (
              <HoverTip label={installFailed ? state.error : undefined}>
                <Button size="sm" disabled={busy} onClick={() => onInstall(update.version)}>
                  {installFailed ? <XIcon /> : <ArrowDownToLineIcon />}{t("desktop.appUpdates.update")}
                </Button>
              </HoverTip>
            ) : null}
          </div>
          {update.notes?.trim() ? (
            <ScrollArea className="min-w-0 border-t pt-1" gutter={false} viewportClassName="max-h-[min(40vh,24rem)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50" viewportProps={{ role: "region", "aria-label": t("desktop.appUpdates.release_notes"), tabIndex: 0 }} scrollbars="vertical">
              <ReleaseNotesContent notes={update.notes} />
            </ScrollArea>
          ) : null}
        </div>
      ) : null}
      {state.status === "installed" ? (
        <div>
          <HoverTip label={restartFailed ? state.error : undefined}>
            <Button size="sm" disabled={busy} onClick={onRestart}>
              <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                {state.request === "restart" ? <RotateCwIcon className="motion-safe:animate-spin" /> : restartFailed ? <XIcon /> : <RotateCwIcon />}
              </span>
              {t("desktop.appUpdates.restart_rebaseraven")}
            </Button>
          </HoverTip>
        </div>
      ) : null}
      <span role="status" className="sr-only">{installFailed || restartFailed ? state.error : null}</span>
    </section>
  );
}


function ReleaseNotesContent({ notes }: { notes: string }) {
  const [Renderer, setRenderer] = useState<NotesRenderer | null>(() => cachedNotesRenderer);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (Renderer) return;
    let current = true;
    void import("@/components/release-notes").then((module) => {
      cachedNotesRenderer = module.default;
      if (current) setRenderer(() => module.default);
    }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [Renderer, attempt]);

  if (Renderer) return <Renderer notes={notes} label={t("desktop.appUpdates.release_notes")} onOpenLink={openReleaseNoteLink} />;
  if (!failed) return <p role="status" className="p-3">{t("common.loading")}</p>;
  return <div className="p-3">
    <div role="alert" className="mb-3 flex items-start gap-3">
      <p className="min-w-0 flex-1 leading-relaxed">{t("desktop.appUpdates.could_not_load_release_notes")}</p>
      <Button size="xs" variant="outline" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>{t("common.retry")}</Button>
    </div>
    <p className="whitespace-pre-wrap break-words text-foreground">{notes}</p>
  </div>;
}
