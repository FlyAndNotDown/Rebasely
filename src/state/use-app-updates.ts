import { useSyncExternalStore } from "react";
import { updaterApi } from "@/lib/updater";
import { createUpdateStore } from "@/state/app-updates";

export const appUpdates = createUpdateStore(updaterApi);

export function useAppUpdates() {
  return useSyncExternalStore(appUpdates.subscribe, appUpdates.getSnapshot, appUpdates.getSnapshot);
}
