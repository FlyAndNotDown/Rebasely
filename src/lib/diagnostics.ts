import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticExport, DiagnosticSummary } from "@/types/diagnostics";

export const diagnosticsApi = {
  summary: () => invoke<DiagnosticSummary>("get_diagnostic_summary"),
  export: (destination: string) => invoke<DiagnosticExport>("export_diagnostic_logs", { destination }),
  openDirectory: () => invoke<void>("open_diagnostic_directory"),
  openIssues: () => invoke<void>("open_diagnostic_issues"),
};
