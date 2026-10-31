/** Merges edits immediately and lets only the latest save normalize the draft. */
export function createSettingsWriter<T extends object>(initial: T) {
  let value = initial;
  let revision = 0;
  let pending: number | null = null;

  return {
    get value() { return value; },
    get revision() { return revision; },
    sync(saved: T) {
      if (pending === null) value = saved;
    },
    async save(patch: Partial<T>, write: (next: T) => Promise<T>): Promise<T> {
      const request = ++revision;
      pending = request;
      const next = { ...value, ...patch };
      value = next;
      try {
        const saved = await write(next);
        if (pending === request) value = saved;
        return saved;
      } finally {
        if (pending === request) pending = null;
      }
    },
  };
}
