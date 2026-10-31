export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "installed"
  | "error";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  publishedAt: string | null;
}

export interface UpdateState {
  revision: number;
  status: UpdateStatus;
  update: UpdateInfo | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}
