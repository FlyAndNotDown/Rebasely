import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateState } from "@/types/updater";

export const updaterApi = {
  getState: () => invoke<UpdateState>("get_update_state"),
  check: () => invoke<UpdateState>("check_for_update"),
  install: (version: string) => invoke<UpdateState>("install_update", { version }),
  restart: () => invoke<void>("restart_after_update"),
  subscribe: (listener: (state: UpdateState) => void) =>
    listen<UpdateState>("app-update", ({ payload }) => listener(payload)),
};
