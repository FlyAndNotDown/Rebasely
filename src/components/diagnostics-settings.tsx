import { useEffect, useId, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { DownloadIcon, ExternalLinkIcon, FolderOpenIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { diagnosticsApi } from "@/lib/diagnostics";
import type { DiagnosticSummary } from "@/types/diagnostics";

type Action = "refresh" | "export" | "directory" | "issues";

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function DiagnosticsSettings() {
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
      if (current) setError("Could not read local diagnostics. Try again.");
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
            title: "Export local diagnostics",
            defaultPath: "rebasely-diagnostics.zip",
            filters: [{ name: "ZIP archive", extensions: ["zip"] }],
          });
          if (!destination || !mounted.current) return;
          const result = await diagnosticsApi.export(destination);
          if (mounted.current) setNotice(result.skippedEntries > 0
            ? "ZIP exported. Unrecognized diagnostic entries were excluded."
            : "ZIP exported. Review it before sharing in an issue.");
          break;
        }
        case "directory": await diagnosticsApi.openDirectory(); break;
        case "issues": await diagnosticsApi.openIssues(); break;
      }
    } catch {
      if (mounted.current) setRetryAction(next);
      if (mounted.current) setError(next === "export"
        ? "Could not export diagnostics. Choose a writable ZIP file and try again."
        : next === "refresh" ? "Could not read local diagnostics. Try again."
        : next === "directory" ? "Could not open the diagnostics folder. Try again."
        : "Could not open Issues. Try again.");
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
            <h3 id={titleId} className="text-sm font-medium">Local diagnostics</h3>
            <HoverTip label="Only diagnostic codes, timestamps, durations, app version, and platform. No repository paths, URLs, usernames, credentials, command output, or original errors. Nothing is uploaded automatically.">
              <Button variant="ghost" size="icon-xs" aria-label="About local diagnostics"><InfoIcon /></Button>
            </HoverTip>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Kept on this device. Share an exported ZIP yourself.</p>
        </div>
        <HoverTip label="Refresh diagnostic storage usage">
          <Button variant="outline" size="icon-sm" aria-label="Refresh diagnostic storage usage" disabled={action !== null} onClick={() => void run("refresh")}>
            <RefreshCwIcon className={action === "refresh" ? "motion-safe:animate-spin" : ""} />
          </Button>
        </HoverTip>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {summary ? `${sizeLabel(summary.totalBytes)} / ${sizeLabel(summary.maxBytes)} · ${summary.fileCount} log ${summary.fileCount === 1 ? "file" : "files"}`
          : action === "refresh" ? "Reading diagnostic storage…" : "Storage usage unavailable."}
      </p>
      {error ? <div role="alert" className="flex items-center gap-2 text-xs text-destructive"><p className="flex-1">{error}</p><Button variant="outline" size="sm" disabled={action !== null} onClick={() => void run(retryAction)}>Retry</Button></div> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={action !== null} onClick={() => void run("export")}><DownloadIcon />{action === "export" ? "Exporting…" : "Export ZIP"}</Button>
        <Button variant="outline" size="sm" disabled={action !== null} onClick={() => void run("directory")}><FolderOpenIcon />Open folder</Button>
        <Button variant="outline" size="sm" disabled={action !== null} onClick={() => void run("issues")}><ExternalLinkIcon />Open Issues</Button>
      </div>
      {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
    </section>
  );
}
