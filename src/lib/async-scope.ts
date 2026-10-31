/** Superseded or closed resources cannot publish a result or an error. */
export function createLatestRequest() {
  let generation = 0;
  return {
    run<T>(load: () => Promise<T>, complete: (value: T) => void, failed: (error: unknown) => void) {
      const request = ++generation;
      void Promise.resolve().then(load).then((value) => {
        if (generation === request) complete(value);
      }).catch((error: unknown) => {
        if (generation === request) failed(error);
      });
      return () => { if (generation === request) generation += 1; };
    },
  };
}

/** Acquires synchronously so two clicks cannot launch mutations before a render. */
export function createExclusiveAction() {
  let busy = false;
  return {
    async run(action: () => Promise<void>): Promise<boolean> {
      if (busy) return false;
      busy = true;
      try { await action(); return true; }
      finally { busy = false; }
    },
    get busy() { return busy; },
  };
}
