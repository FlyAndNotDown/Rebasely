import { errorMessage } from "@/lib/git";
import { P4_LOGIN, p4Api } from "@/lib/p4";
import type { P4Connection } from "@/types/p4";

export async function withP4Login<T>(request: () => Promise<T>, login: () => Promise<void>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (errorMessage(error) !== P4_LOGIN) throw error;
    await login();
    return request();
  }
}

export function pendingDiffRequest(connection: P4Connection, change: string, file: string, shelved: boolean) {
  return () => shelved
    ? p4Api.shelfDiff(connection, file, change)
    : p4Api.openedDiff(connection, file);
}
