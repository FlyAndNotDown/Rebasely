export interface DiagnosticSummary {
  totalBytes: number;
  fileCount: number;
  maxBytes: number;
  retentionDays: number;
}

export interface DiagnosticExport {
  fileCount: number;
  skippedEntries: number;
}
