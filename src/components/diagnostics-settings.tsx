import { formatBytes, t, useTranslation } from "@/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { DownloadIcon, ExternalLinkIcon, FolderOpenIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { diagnosticsApi } from "@/lib/diagnostics";
import type { DiagnosticSummary } from "@/types/diagnostics";

type Action = "refresh" | "export" | "directory" | "issues";

export function DiagnosticsSettings() {
  useTranslation();
  const titleId = useId();
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [action, setAction] = useState<Action | null>("refresh");
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<Action>("refresh");
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const busy = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void diagnosticsApi.summary().then((value) => {
      if (current) setSummary(value);
    }).catch(() => {
      if (current) setError(t("desktop.diagnosticsSettings.could_not_read_local_diagnostics_try_again"));
    }).finally(() => {
      if (current) {
        busy.current = false;
        setAction(null);
      }
    });
    return () => { current = false; mounted.current = false; };
  }, []);

  async function run(next: Action) {
    if (busy.current) return;
    busy.current = true;
    setAction(next);
    setError(null);
    setNotice(null);
    try {
      switch (next) {
        case "refresh": {
          const value = await diagnosticsApi.summary();
          if (mounted.current) setSummary(value);
          break;
        }
        case "export": {
          const destination = await save({
            title: t("desktop.diagnosticsSettings.export_local_diagnostics"),
            defaultPath: "rebasely-diagnostics.zip",
            filters: [{ name: t("desktop.diagnosticsSettings.zipArchive"), extensions: ["zip"] }],
          });
          if (!destination || !mounted.current) return;
          const result = await diagnosticsApi.export(destination);
          if (mounted.current) setNotice(result.skippedEntries > 0
            ? t("desktop.diagnosticsSettings.zip_exported_unrecognized_diagnostic_entries_were_excluded")
            : t("desktop.diagnosticsSettings.zip_exported_review_it_before_sharing_in_an"));
          break;
        }
        case "directory": await diagnosticsApi.openDirectory(); break;
        case "issues": await diagnosticsApi.openIssues(); break;
      }
    } catch {
      if (mounted.current) setRetryAction(next);
      if (mounted.current) setError(next === "export"
        ? t("desktop.diagnosticsSettings.could_not_export_diagnostics_choose_a_writable_zip")
        : next === "refresh" ? t("desktop.diagnosticsSettings.could_not_read_local_diagnostics_try_again")
        : next === "directory" ? t("desktop.diagnosticsSettings.could_not_open_the_diagnostics_folder_try_again")
        : t("desktop.diagnosticsSettings.could_not_open_issues_try_again"));
    } finally {
      busy.current = false;
      if (mounted.current) setAction(null);
    }
  }

  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 id={titleId} className="text-sm font-medium">{t("desktop.diagnosticsSettings.local_diagnostics")}</h3>
            <HoverTip label={t("desktop.diagnosticsSettings.only_diagnostic_codes_timestamps_durations_app_version_and")}>
              <Button variant="ghost" size="icon-xs" aria-label={t("desktop.diagnosticsSettings.about_local_diagnostics")}><InfoIcon /></Button>
            </HoverTip>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("desktop.diagnosticsSettings.kept_on_this_device_share_an_exported_zip")}</p>
        </div>
        <HoverTip label={t("desktop.diagnosticsSettings.refresh_diagnostic_storage_usage")}>
          <Button variant="outline" size="icon-sm" aria-label={t("desktop.diagnosticsSettings.refresh_diagnostic_storage_usage")} disabled={action !== null} onClick={() => void run("refresh")}>
            <RefreshCwIcon className={action === "refresh" ? "motion-safe:animate-spin" : ""} />
          </Button>
        </HoverTip>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {summary ? t("desktop.diagnosticsSettings.storageUsage", { used: formatBytes(summary.totalBytes), maximum: formatBytes(summary.maxBytes), count: summary.fileCount })
          : action === "refresh" ? t("desktop.diagnosticsSettings.reading_diagnostic_storage") : t("desktop.diagnosticsSettings.storage_usage_unavailable")}
      </p>
      {error ? <div role="alert" className="flex items-center gap-2 text-xs text-destructive"><p className="flex-1">{error}</p><Button variant="outline" size="sm" disabled={action !== null} onClick={() => void run(retryAction)}>{t("common.retry")}</Button></div> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={action !== null} onClick={() => void run("export")}><DownloadIcon />{action === "export" ? t("desktop.diagnosticsSettings.exporting") : t("desktop.diagnosticsSettings.export_zip")}</Button>
        <Button variant="outline" size="sm" disabled={action !== null} onClick={() => void run("directory")}><FolderOpenIcon />{t("desktop.sshKeysSettings.open_folder")}</Button>
        <Button variant="outline" size="sm" disabled={action !== null} onClick={() => void run("issues")}><ExternalLinkIcon />{t("desktop.diagnosticsSettings.open_issues")}</Button>
      </div>
      {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
    </section>
  );
}
