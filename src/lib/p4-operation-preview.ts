import type { P4Connection, P4IntegrateRequest, P4UndoRequest } from "@/types/p4";
import { t } from "@/i18n";

export type P4OperationKind = "integrate" | "undo";

const operationErrors: Record<string, string> = {
  "The operation or workspace changed. Preview it again before applying.": "stale",
  "Enter a positive revision or changelist number.": "number",
  "The first revision must not exceed the last revision.": "range",
  "Choose your own pending changelist in this workspace.": "pendingChange",
  "Choose one depot file without wildcards or revision suffixes.": "source",
  "Choose one absolute local workspace file.": "target",
  "Choose a regular workspace file, not a folder or symbolic link.": "regularFile",
  "Choose a file mapped once by this workspace view.": "mapping",
  "The file mapping does not match the selected workspace file.": "mappingMismatch",
  "Choose the exact depot file path returned by Perforce.": "exactDepotPath",
  "Choose an absent target or one versioned workspace file.": "versionedTarget",
  "Choose a numbered changelist.": "numberedChange",
  "Unsupported file action.": "unsupportedAction",
  "Choose a file.": "chooseFile",
  "Choose a pending changelist to lock or unlock files.": "lockChange",
  "Choose explicit opened files to lock or unlock.": "lockFiles",
  "Resolve or revert this file's pending action before moving it.": "pendingMoveAction",
  "Choose a local workspace file.": "localFile",
  "Choose a regular workspace file.": "regularLocalFile",
  "Choose a versioned workspace file.": "versionedFile",
  "Enter a relative destination inside this workspace.": "relativeDestination",
  "Enter a file name.": "fileName",
  "The destination already exists. Choose another file name.": "destinationExists",
  "Path is outside the workspace.": "outsideWorkspace",
  "Folder not found.": "folderMissing",
};

export function p4OperationErrorKey(message: string): string | null {
  const key = operationErrors[message];
  return key ? `p4-operations.errors.${key}` : null;
}

/** Localize only exact application messages; native command diagnostics stay intact. */
export function p4DisplayError(message: string, language?: string): string {
  const key = p4OperationErrorKey(message);
  return key ? t(key, { lng: language }) : message;
}

export function p4OperationKey(kind: P4OperationKind, connection: P4Connection, request: P4IntegrateRequest | P4UndoRequest): string {
  return JSON.stringify([kind, connection, request]);
}

/** A changed form or closed dialog cannot approve an earlier asynchronous preview. */
export function createP4PreviewGate() {
  let generation = 0;
  let approved: { key: string; fingerprint: string } | null = null;
  return {
    begin(key: string) {
      approved = null;
      return { generation: ++generation, key };
    },
    complete(request: { generation: number; key: string }, fingerprint: string): boolean {
      if (request.generation !== generation || !fingerprint) return false;
      approved = { key: request.key, fingerprint };
      return true;
    },
    accepts(key: string, fingerprint: string): boolean {
      return approved?.key === key && approved.fingerprint === fingerprint;
    },
    invalidate() {
      generation += 1;
      approved = null;
    },
  };
}
