/** A synchronous lease prevents duplicate clicks before React renders the busy state. */
export function acquireP4Mutation(owners: Set<string>, owner: string): (() => void) | null {
  if (owners.has(owner)) return null;
  owners.add(owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners.delete(owner);
  };
}

/** Reconnecting an inactive owner must leave the current workspace usable. */
export function invalidateP4Session<T>(sessions: Map<string, T>, owner: string, active: string, reconnect: () => void) {
  sessions.delete(owner);
  if (owner === active) reconnect();
}
