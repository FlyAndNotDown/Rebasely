import { formatBytes, t, useTranslation } from "@/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckIcon, DownloadIcon, ExternalLinkIcon, FolderOpenIcon, InfoIcon, LoaderCircleIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { HoverTip } from "@/components/ui/tooltip";
import { diagnosticsApi } from "@/lib/diagnostics";
import type { DiagnosticSummary } from "@/types/diagnostics";

type Action = "refresh" | "export" | "directory" | "issues" | "clear";
type Feedback = { outcome: "success" | "warning" | "error"; message: string };
const actions: Action[] = ["refresh", "export", "directory", "issues", "clear"];

export function DiagnosticsSettings() {
  useTranslation();
  const titleId = useId();
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [feedback, setFeedback] = useState<Partial<Record<Action, Feedback>>>({});
  const [clearOpen, setClearOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const reads = useRef(Promise.resolve());
  const refreshing = loadedRevision !== revision;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    reads.current = reads.current.then(async () => {
      if (!current) return;
      try {
        const value = await diagnosticsApi.summary();
        if (current) {
          setSummary(value);
          setLoadedRevision(revision);
          setFeedback((previous) => ({
            ...previous,
            refresh: revision > 0
              ? { outcome: "success", message: t("desktop.diagnosticsSettings.storage_refreshed") }
              : undefined,
          }));
        }
      } catch {
        if (current) {
          setSummary(null);
          setLoadedRevision(revision);
          setFeedback((previous) => ({ ...previous, refresh: {
            outcome: "error",
            message: t("desktop.diagnosticsSettings.could_not_read_local_diagnostics_try_again"),
          } }));
        }
      }
    });
    return () => { current = false; };
  }, [revision]);

  async function run(next: Action) {
    if (busy.current) return;
    busy.current = true;
    setAction(next);
    setFeedback((previous) => ({ ...previous, [next]: undefined }));
    try {
      switch (next) {
        case "refresh":
          setRevision((revision) => revision + 1);
          break;
        case "clear":
          await reads.current;
          await diagnosticsApi.clear();
          if (mounted.current) {
            setClearOpen(false);
            setFeedback((previous) => ({ ...previous, clear: {
              outcome: "success",
              message: t("desktop.diagnosticsSettings.logs_cleared"),
            } }));
          }
          break;
        case "export": {
          const destination = await save({
            title: t("desktop.diagnosticsSettings.export_local_diagnostics"),
            defaultPath: "rebaseraven-diagnostics.zip",
            filters: [{ name: t("desktop.diagnosticsSettings.zipArchive"), extensions: ["zip"] }],
          });
          if (!destination || !mounted.current) return;
          const result = await diagnosticsApi.export(destination);
          if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: {
            outcome: result.skippedEntries > 0 ? "warning" : "success",
            message: result.skippedEntries > 0
              ? `${t("desktop.diagnosticsSettings.zip_exported_unrecognized_diagnostic_entries_were_excluded")} ${t("desktop.diagnosticsSettings.review_export_before_sharing")}`
              : t("desktop.diagnosticsSettings.zip_exported_review_it_before_sharing_in_an"),
          } }));
          break;
        }
        case "directory":
          await diagnosticsApi.openDirectory();
          if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: { outcome: "success", message: t("desktop.diagnosticsSettings.diagnostics_folder_opened") } }));
          break;
        case "issues":
          await diagnosticsApi.openIssues();
          if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: { outcome: "success", message: t("desktop.diagnosticsSettings.issues_opened") } }));
          break;
      }
    } catch {
      if (mounted.current) setFeedback((previous) => ({ ...previous, [next]: {
        outcome: "error",
        message: next === "export"
          ? t("desktop.diagnosticsSettings.could_not_export_diagnostics_choose_a_writable_zip")
          : next === "clear" ? t("desktop.diagnosticsSettings.could_not_clear_all_logs")
          : next === "refresh" ? t("desktop.diagnosticsSettings.could_not_read_local_diagnostics_try_again")
          : next === "directory" ? t("desktop.diagnosticsSettings.could_not_open_the_diagnostics_folder_try_again")
          : t("desktop.diagnosticsSettings.could_not_open_issues_try_again"),
      } }));
    } finally {
      busy.current = false;
      if (mounted.current) {
        setAction(null);
        if (next === "clear") setRevision((revision) => revision + 1);
      }
    }
  }

  function actionIcon(next: Action, IdleIcon: LucideIcon) {
    if (action === next || (next === "refresh" && refreshing)) return <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />;
    const result = feedback[next];
    if (!result) return <IdleIcon aria-hidden="true" />;
    if (result.outcome === "error") return <XIcon className="text-destructive" aria-hidden="true" />;
    if (result.outcome === "warning") return <TriangleAlertIcon className="text-status-warning" aria-hidden="true" />;
    return <CheckIcon aria-hidden="true" />;
  }

  function actionTip(next: Action, idle: string) {
    return feedback[next]?.message ?? idle;
  }

  function announcement(next: Action) {
    return action === next && next === "export" ? t("desktop.diagnosticsSettings.exporting")
      : refreshing && next === "refresh" ? t("desktop.diagnosticsSettings.reading_diagnostic_storage") : feedback[next]?.message ?? "";
  }

  return (
    <section aria-labelledby={titleId} className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 id={titleId} className="text-sm font-medium">{t("desktop.diagnosticsSettings.local_diagnostics")}</h3>
          <HoverTip label={[
            t("desktop.diagnosticsSettings.local_log_contents"),
            summary ? t("desktop.diagnosticsSettings.retention", { days: summary.retentionDays, maximum: formatBytes(summary.maxBytes) }) : "",
          ].filter(Boolean).join("\n")}>
            <Button variant="ghost" size="icon-xs" aria-label={t("desktop.diagnosticsSettings.about_local_diagnostics")}><InfoIcon /></Button>
          </HoverTip>
        </div>
        <HoverTip label={actionTip("refresh", t("desktop.diagnosticsSettings.refresh_diagnostic_storage_usage"))}>
          <Button variant="outline" size="icon-sm" aria-label={t("desktop.diagnosticsSettings.refresh_diagnostic_storage_usage")} aria-describedby={`${titleId}-refresh-feedback`} aria-busy={refreshing} disabled={action !== null || refreshing} onClick={() => void run("refresh")}>
            {actionIcon("refresh", RefreshCwIcon)}
          </Button>
        </HoverTip>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {summary ? t("desktop.diagnosticsSettings.storageUsage", { used: formatBytes(summary.totalBytes), maximum: formatBytes(summary.maxBytes), count: summary.fileCount })
          : refreshing ? t("desktop.diagnosticsSettings.reading_diagnostic_storage") : t("desktop.diagnosticsSettings.storage_usage_unavailable")}
      </p>
      <div className="flex flex-wrap gap-2">
        <HoverTip label={actionTip("export", t("desktop.diagnosticsSettings.review_export_before_sharing"))}>
          <Button size="sm" disabled={action !== null || refreshing} aria-busy={action === "export"} aria-describedby={`${titleId}-export-feedback`} onClick={() => void run("export")}>
            {actionIcon("export", DownloadIcon)}{t("desktop.diagnosticsSettings.export_zip")}
          </Button>
        </HoverTip>
        <HoverTip label={actionTip("directory", t("desktop.sshKeysSettings.open_folder"))}>
          <Button variant="outline" size="sm" disabled={action !== null} aria-busy={action === "directory"} aria-describedby={`${titleId}-directory-feedback`} onClick={() => void run("directory")}>
            {actionIcon("directory", FolderOpenIcon)}{t("desktop.sshKeysSettings.open_folder")}
          </Button>
        </HoverTip>
        <HoverTip label={actionTip("issues", t("desktop.diagnosticsSettings.open_issues"))}>
          <Button variant="outline" size="sm" disabled={action !== null} aria-busy={action === "issues"} aria-describedby={`${titleId}-issues-feedback`} onClick={() => void run("issues")}>
            {actionIcon("issues", ExternalLinkIcon)}{t("desktop.diagnosticsSettings.open_issues")}
          </Button>
        </HoverTip>
        <Dialog open={clearOpen} onOpenChange={(open) => {
          if (busy.current) return;
          if (open) setFeedback((previous) => ({ ...previous, clear: undefined }));
          setClearOpen(open);
        }}>
          <HoverTip label={actionTip("clear", t("desktop.diagnosticsSettings.clear_logs"))}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={action !== null} aria-describedby={`${titleId}-clear-feedback`}>
                {actionIcon("clear", Trash2Icon)}{t("desktop.diagnosticsSettings.clear_logs")}
              </Button>
            </DialogTrigger>
          </HoverTip>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t("desktop.diagnosticsSettings.clear_logs")}</DialogTitle>
              <DialogDescription>{t("desktop.diagnosticsSettings.clear_logs_confirmation")}</DialogDescription>
            </DialogHeader>
            {feedback.clear?.outcome === "error" ? <p role="alert" className="text-sm text-destructive">{feedback.clear.message}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={action === "clear"}>{t("common.cancel")}</Button>
              </DialogClose>
              <Button variant="destructive" disabled={action !== null} aria-busy={action === "clear"} onClick={() => void run("clear")}>
                {action === "clear" ? <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" /> : null}
                {t("desktop.diagnosticsSettings.clear_logs")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {actions.map((next) => <span key={next} id={`${titleId}-${next}-feedback`} role="status" aria-atomic="true" className="sr-only">{announcement(next)}</span>)}
    </section>
  );
}
