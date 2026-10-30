import { describe, expect, it } from "vitest";
import { acquireP4Mutation, invalidateP4Session } from "./p4-mutations";

describe("Perforce mutation ownership", () => {
  it("blocks duplicate work while other repositories can mutate independently", () => {
    const owners = new Set<string>();
    const releaseFirst = acquireP4Mutation(owners, "first");
    expect(releaseFirst).not.toBeNull();
    expect(acquireP4Mutation(owners, "first")).toBeNull();
    const releaseSecond = acquireP4Mutation(owners, "second");
    expect(releaseSecond).not.toBeNull();
    releaseFirst?.();
    expect(owners.has("first")).toBe(false);
    expect(owners.has("second")).toBe(true);
    releaseSecond?.();
  });

  it.each(["Failed", "Login cancelled"])("releases the original repository after %s", async (message) => {
    const owners = new Set<string>();
    const release = acquireP4Mutation(owners, "first");
    const work = async () => {
      try {
        await Promise.reject(new Error(message));
      } finally {
        release?.();
      }
    };
    await expect(work()).rejects.toThrow(message);
    expect(acquireP4Mutation(owners, "first")).not.toBeNull();
  });

  it("does not let an old completion release a newer operation", () => {
    const owners = new Set<string>();
    const previous = acquireP4Mutation(owners, "first");
    previous?.();
    const current = acquireP4Mutation(owners, "first");
    previous?.();
    expect(acquireP4Mutation(owners, "first")).toBeNull();
    current?.();
    expect(owners.size).toBe(0);
  });

  it("invalidates the original settings session after switching tabs without reconnecting the active one", async () => {
    const sessions = new Map([["first", "old endpoint"], ["second", "current endpoint"]]);
    let active = "first";
    let reconnects = 0;
    let finish!: () => void;
    const saved = new Promise<void>((resolve) => { finish = resolve; });
    const complete = saved.then(() => invalidateP4Session(sessions, "first", active, () => { reconnects += 1; }));
    active = "second";
    finish();
    await complete;
    expect(sessions.has("first")).toBe(false);
    expect(sessions.get("second")).toBe("current endpoint");
    expect(reconnects).toBe(0);
    invalidateP4Session(sessions, "second", active, () => { reconnects += 1; });
    expect(reconnects).toBe(1);
  });
});
