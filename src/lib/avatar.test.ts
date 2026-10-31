import { describe, expect, it, vi } from "vitest";
import { avatarColor, avatarHue, avatarInitial, avatarSeed, createAvatarLoader } from "./avatar";

describe("avatar", () => {
  it("falls back from name to email to a placeholder", () => {
    expect(avatarSeed(" Ada ", "ada@example.com")).toBe("Ada");
    expect(avatarSeed("", "ada@example.com")).toBe("ada@example.com");
    expect(avatarSeed(" ", "")).toBe("user");
  });

  it("uses the first letter or digit", () => {
    expect(avatarInitial("ada")).toBe("A");
    expect(avatarInitial("(bot) 42")).toBe("B");
    expect(avatarInitial("omega")).toBe("O");
    expect(avatarInitial("---")).toBe("?");
  });

  it("gives the same author the same hue", () => {
    expect(avatarHue("Ada")).toBe(avatarHue("Ada"));
    expect(avatarHue("Ada")).toBeGreaterThanOrEqual(0);
    expect(avatarHue("Ada")).toBeLessThan(360);
  });

  it("picks a stable color", () => {
    expect(avatarColor("Ada")).toBe(avatarColor("Ada"));
    expect(avatarColor("Ada")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

const IMAGE = "data:image/png;base64,aGVsbG8=";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("optional author avatars", () => {
  it("never calls the provider for builtin avatars or invalid email values", async () => {
    const fetch = vi.fn(async () => IMAGE);
    const loader = createAvatarLoader(fetch);
    expect(await loader.get("builtin", "alice@example.com")).toBeNull();
    expect(await loader.get("github", "Alice Example")).toBeNull();
    expect(await loader.get("github", "alice@example.com in:login")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("merges duplicate rows and retains only data images", async () => {
    const result = deferred<string | null>();
    const fetch = vi.fn(() => result.promise);
    const loader = createAvatarLoader(fetch);
    const first = loader.get("github", "Alice@example.com");
    expect(loader.get("github", "alice@example.com")).toBe(first);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    result.resolve(IMAGE);
    expect(await first).toBe(IMAGE);
    expect(await loader.get("github", "alice@example.com")).toBe(IMAGE);
    expect(fetch).toHaveBeenCalledTimes(1);
    const unsafe = createAvatarLoader(async () => "https://example.com/avatar.svg");
    expect(await unsafe.get("gitlab", "alice@example.com")).toBeNull();
  });

  it("limits concurrency and invalidates queued and in-flight work after switching providers", async () => {
    const results = [deferred<string | null>(), deferred<string | null>(), deferred<string | null>()];
    const fetch = vi.fn((_provider: string, email: string) => results[email === "a@example.com" ? 0 : email === "b@example.com" ? 1 : 2].promise);
    const loader = createAvatarLoader(fetch);
    const a = loader.get("github", "a@example.com");
    const b = loader.get("github", "b@example.com");
    const queued = loader.get("github", "c@example.com");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await loader.get("builtin", "a@example.com")).toBeNull();
    expect(await queued).toBeNull();
    results[0].resolve(IMAGE);
    results[1].resolve(IMAGE);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    const fresh = loader.get("gitlab", "c@example.com");
    await Promise.resolve();
    await Promise.resolve();
    results[2].resolve(IMAGE);
    expect(await fresh).toBe(IMAGE);
    expect(fetch).toHaveBeenLastCalledWith("gitlab", "c@example.com");
  });

  it("negative-caches failures for a finite duration", async () => {
    let now = 0;
    const fetch = vi.fn(async (): Promise<string | null> => { throw new Error("Unavailable"); });
    const loader = createAvatarLoader(fetch, () => now);
    expect(await loader.get("github", "alice@example.com")).toBeNull();
    expect(await loader.get("github", "alice@example.com")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 16 * 60_000;
    expect(await loader.get("github", "alice@example.com")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("evicts old images when the memory budget is full", async () => {
    const fetch = vi.fn(async () => `data:image/png;base64,${"A".repeat(87_384)}`);
    const loader = createAvatarLoader(fetch);
    for (let index = 0; index < 60; index += 1) await loader.get("github", `author${index}@example.com`);
    expect(fetch).toHaveBeenCalledTimes(60);
    await loader.get("github", "author0@example.com");
    expect(fetch).toHaveBeenCalledTimes(61);
  });
});
