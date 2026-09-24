import { useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { sameRepoPath } from "@/lib/format";
import type { RepoChangedPayload } from "@/lib/repo-paths";

/**
 * Calls `onChange` when the file watcher reports changes in `repoPath`. The
 * argument lists the changed absolute paths, or is null when the watcher
 * overflowed and could not say which paths changed.
 */
export function useRepoChanged(repoPath: string, onChange: (changed: string[] | null) => void) {
  const callback = useRef(onChange);
  useLayoutEffect(() => {
    callback.current = onChange;
  });

  useEffect(() => {
    if (!repoPath) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<RepoChangedPayload | string>("repo-changed", (event) => {
      const payload =
        typeof event.payload === "string"
          ? { path: event.payload, paths: [], overflow: true }
          : event.payload;
      if (!sameRepoPath(payload.path, repoPath)) return;
      callback.current(payload.overflow ? null : (payload.paths ?? []));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [repoPath]);
}
