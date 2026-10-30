export interface AskpassPrompt {
  id: number;
  prompt: string;
  activityId: string | null;
}

/** Remove requests before answering so finished activities cannot release them twice. */
export function createAskpassQueue(
  answer: (id: number, value: string | null) => Promise<unknown>,
  cancelActivity: (activityId: string) => Promise<unknown> = async () => undefined,
) {
  let prompts: AskpassPrompt[] = [];
  const listeners = new Set<() => void>();
  function update(next: AskpassPrompt[]) {
    prompts = next;
    for (const listener of listeners) listener();
  }
  function reply(id: number, value: string | null) {
    void answer(id, value).catch(() => undefined);
  }
  return {
    getSnapshot: () => prompts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    enqueue(prompt: AskpassPrompt) {
      if (!prompts.some((item) => item.id === prompt.id)) update([...prompts, prompt]);
    },
    async respond(id: number, value: string | null) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt) return;
      update(prompts.filter((item) => item.id !== id));
      if (value === null && prompt.activityId) {
        try {
          // Mark and stop the owner before Git observes an empty askpass response.
          await cancelActivity(prompt.activityId);
        } catch {
          // The credential waiter must still be released if cancellation failed.
        }
      }
      reply(id, value);
    },
    releaseInactive(activities: ReadonlySet<string>) {
      const expired = prompts.filter((item) => item.activityId && !activities.has(item.activityId));
      if (expired.length === 0) return;
      const expiredIds = new Set(expired.map((item) => item.id));
      update(prompts.filter((item) => !expiredIds.has(item.id)));
      for (const item of expired) reply(item.id, null);
    },
    dispose() {
      const pending = prompts;
      update([]);
      for (const item of pending) reply(item.id, null);
    },
  };
}
