import { describe, expect, it, vi } from "vitest";
import type { AppPrefs } from "@/types/git";
import { createSettingsWriter } from "./settings-writes";

type Preferences = Pick<AppPrefs, "avatarProvider" | "autoFetchMinutes" | "editorId">;
const initial: Preferences = { avatarProvider: "builtin", autoFetchMinutes: 10, editorId: "system" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

describe("settings writes", () => {
  it("keeps the newest avatar choice when saves A, B, and C finish B, A, C", async () => {
    const writer = createSettingsWriter(initial);
    const completions = [deferred<Preferences>(), deferred<Preferences>(), deferred<Preferences>()];
    const write = vi.fn((_next: Preferences) => completions[write.mock.calls.length - 1].promise);
    const a = writer.save({ avatarProvider: "github" }, write);
    const b = writer.save({ autoFetchMinutes: 30 }, write);
    completions[1].resolve({ ...initial, avatarProvider: "github", autoFetchMinutes: 30 });
    await b;

    const c = writer.save({ avatarProvider: "builtin" }, write);
    // A can return late after an unrelated executable availability probe.
    completions[0].resolve({ ...initial, avatarProvider: "github" });
    await a;
    expect(writer.value).toEqual({ ...initial, autoFetchMinutes: 30 });
    completions[2].resolve({ ...initial, autoFetchMinutes: 30 });
    await c;

    const nextWrite = vi.fn(async (next: Preferences) => next);
    await writer.save({ editorId: "code" }, nextWrite);
    expect(nextWrite).toHaveBeenCalledWith({ avatarProvider: "builtin", autoFetchMinutes: 30, editorId: "code" });
  });

  it("protects pending edits from incoming snapshots and accepts the latest normalized save", async () => {
    const writer = createSettingsWriter(initial);
    const result = deferred<Preferences>();
    const save = writer.save({ editorId: "editor" }, () => result.promise);
    writer.sync({ ...initial, avatarProvider: "github" });
    expect(writer.value.editorId).toBe("editor");
    result.resolve({ ...initial, editorId: "resolved-editor" });
    await save;
    expect(writer.value.editorId).toBe("resolved-editor");
    writer.sync({ ...initial, autoFetchMinutes: 60 });
    expect(writer.value.autoFetchMinutes).toBe(60);
  });

  it("preserves entered edits after failure and releases saving for a retry", async () => {
    const writer = createSettingsWriter(initial);
    const result = deferred<Preferences>();
    const save = writer.save({ avatarProvider: "gitlab" }, () => result.promise);
    result.reject(new Error("Save unavailable"));
    await expect(save).rejects.toThrow("Save unavailable");
    const retry = vi.fn(async (next: Preferences) => next);
    await writer.save({}, retry);
    expect(retry).toHaveBeenCalledWith({ ...initial, avatarProvider: "gitlab" });
    writer.sync(initial);
    expect(writer.value).toEqual(initial);
  });
});
