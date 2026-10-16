import type { FileDiff } from "@/types/git";

export interface P4Connection {
  root: string;
  port: string;
  user: string;
  client: string;
  charset: string;
  stream: string | null;
  server: string;
}

export interface P4File {
  depotPath: string;
  localPath: string;
  action: string;
  rev: string;
  shelved: boolean;
  binary: boolean;
  status: string;
  detail: string;
}

export interface P4Changelist {
  id: string;
  user: string;
  client: string;
  status: string;
  description: string;
  time: number;
  shelved: boolean;
  files: P4File[];
}

export interface P4ChangePage {
  changes: P4Changelist[];
  hasMore: boolean;
  scannedThrough: number | null;
}

export interface P4Describe {
  change: P4Changelist;
  diffs: FileDiff[];
}

export interface P4Revision {
  rev: string;
  change: string;
  action: string;
  user: string;
  time: number;
  description: string;
}

export interface P4DirEntry {
  name: string;
  path: string;
  dir: boolean;
  status: string;
  detail: string;
}

export interface P4FileSearch {
  hits: P4DirEntry[];
  truncated: boolean;
}

export interface P4Auth {
  port: string;
  user: string;
  password: string;
  charset: string;
}

export interface P4ClientOption {
  name: string;
  root: string;
  stream: string;
  description: string;
}

export interface P4StreamOption {
  path: string;
  kind: string;
}

export interface P4DepotEntry {
  path: string;
  dir: boolean;
}

export interface P4CheckedConnection {
  server: string;
  clients: P4ClientOption[];
}

export interface P4CreateRequest {
  port: string;
  user: string;
  password: string;
  client: string;
  root: string;
  stream: string;
  depotPath: string;
  charset: string;
}

export type P4OpenResult =
  | { status: "ready"; connection: P4Connection; pending: P4Changelist[] }
  | { status: "login"; connection: P4Connection };

export type RepoDetection =
  | { kind: "git"; path: string }
  | { kind: "perforce"; connection: P4Connection }
  | { kind: "ambiguous"; path: string; gitPath: string; connection: P4Connection }
  | { kind: "none"; path: string };

export interface P4Executables {
  pathP4: string | null;
  active: string | null;
}
