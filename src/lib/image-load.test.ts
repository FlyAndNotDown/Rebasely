import { describe, expect, it, vi } from "vitest";
import type { ImagePair } from "@/types/git";
import { createImageLoader, imageLoadKey } from "./image-load";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

const source = { kind: "workdir" as const, path: "pixel.png", staged: false };
const pointer: ImagePair = { before: { dataUrl: null, size: 128, lfs: true, tooLarge: false }, after: null };
const image: ImagePair = { before: { dataUrl: "data:image/png;base64,AAAA", size: 32, lfs: false, tooLarge: false }, after: null };

describe("image refresh ownership", () => {
  it("reloads unchanged binary metadata and keeps the old image while loading", async () => {
    const replacement = deferred<ImagePair>();
    const load = vi.fn().mockResolvedValueOnce(pointer).mockReturnValueOnce(replacement.promise);
    const loader = createImageLoader(load, String);
    loader.start("/work/repo", source, {}, 0);
    await vi.waitFor(() => expect(loader.getSnapshot().pair).toBe(pointer));
    const refreshedDiff = {};
    loader.start("/work/repo", source, refreshedDiff, 0);
    expect(loader.getSnapshot()).toMatchObject({ pair: pointer, busy: true, identity: refreshedDiff });
    replacement.resolve(image);
    await vi.waitFor(() => expect(loader.getSnapshot()).toMatchObject({ pair: image, busy: false }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not reuse or publish an old repository's identical path", async () => {
    const late = deferred<ImagePair>();
    const load = vi.fn().mockResolvedValueOnce(pointer).mockReturnValueOnce(late.promise).mockResolvedValueOnce(image);
    const loader = createImageLoader(load, String);
    loader.start("/work/repo-a", source, {}, 0);
    await vi.waitFor(() => expect(loader.getSnapshot().pair).toBe(pointer));
    loader.start("/work/repo-a", source, {}, 1);
    await Promise.resolve();
    loader.start("/work/repo-b", source, {}, 0);
    expect(loader.getSnapshot().pair).toBeNull();
    expect(loader.getSnapshot().key).toBe(imageLoadKey("/work/repo-b", source));
    await vi.waitFor(() => expect(loader.getSnapshot().pair).toBe(image));
    late.resolve(pointer);
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.getSnapshot().pair).toBe(image);
  });

  it("keeps a recoverable error with the old pair and permits a new attempt", async () => {
    const load = vi.fn().mockResolvedValueOnce(pointer).mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce(image);
    const loader = createImageLoader(load, (error) => (error as Error).message);
    loader.start("/work/repo", source, {}, 0);
    await vi.waitFor(() => expect(loader.getSnapshot().pair).toBe(pointer));
    loader.start("/work/repo", source, {}, 1);
    await vi.waitFor(() => expect(loader.getSnapshot()).toMatchObject({ pair: pointer, error: "Unavailable", busy: false }));
    loader.start("/work/repo", source, {}, 2);
    expect(loader.getSnapshot().error).toBeNull();
    await vi.waitFor(() => expect(loader.getSnapshot().pair).toBe(image));
  });

  it("does not publish a late failure after the pane closes", async () => {
    const late = deferred<ImagePair>();
    const loader = createImageLoader(() => late.promise, String);
    const notify = vi.fn();
    loader.subscribe(notify);
    const close = loader.start("/work/repo", source, {}, 0);
    close();
    late.reject(new Error("Closed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(loader.getSnapshot().error).toBeNull();
  });
});
