import type { FileSource, ImagePair } from "@/types/git";

export function imageLoadKey(repoPath: string, source: FileSource): string {
  return JSON.stringify([repoPath, source]);
}

interface ImageLoadState {
  key: string;
  identity: unknown;
  attempt: number;
  pair: ImagePair | null;
  error: string | null;
  busy: boolean;
}

/** Refreshes retain only the same repository/source's last successful image. */
export function createImageLoader(
  load: (repoPath: string, source: FileSource) => Promise<ImagePair>,
  describeError: (error: unknown) => string,
) {
  let state: ImageLoadState = { key: "", identity: null, attempt: 0, pair: null, error: null, busy: false };
  let generation = 0;
  const listeners = new Set<() => void>();
  function publish(next: ImageLoadState) {
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(repoPath: string, source: FileSource, identity: unknown, attempt: number) {
      const request = ++generation;
      const key = imageLoadKey(repoPath, source);
      publish({ key, identity, attempt, pair: state.key === key ? state.pair : null, error: null, busy: true });
      void Promise.resolve().then(() => load(repoPath, source)).then((pair) => {
        if (generation === request) publish({ key, identity, attempt, pair, error: null, busy: false });
      }).catch((error: unknown) => {
        if (generation === request) publish({ ...state, error: describeError(error), busy: false });
      });
      return () => { if (generation === request) generation += 1; };
    },
  };
}
