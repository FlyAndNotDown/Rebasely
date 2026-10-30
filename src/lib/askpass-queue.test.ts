import { describe, expect, it, vi } from "vitest";
import { createAskpassQueue } from "./askpass-queue";

describe("credential prompt lifetime", () => {
  it("removes finished activities and releases each waiting request once", () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const queue = createAskpassQueue(answer);
    queue.enqueue({ id: 1, prompt: "Password", activityId: "repo-a-fetch" });
    queue.enqueue({ id: 2, prompt: "Username", activityId: "repo-b-fetch" });
    queue.releaseInactive(new Set(["repo-b-fetch"]));
    expect(queue.getSnapshot().map((item) => item.id)).toEqual([2]);
    expect(answer.mock.calls).toEqual([[1, null]]);
    queue.releaseInactive(new Set(["repo-b-fetch"]));
    expect(answer).toHaveBeenCalledOnce();
  });

  it("answers a prompt only once and preserves unrelated pending prompts", () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const queue = createAskpassQueue(answer);
    const prompt = { id: 1, prompt: "Username", activityId: "repo-a-fetch" };
    queue.enqueue(prompt);
    queue.enqueue(prompt);
    queue.enqueue({ id: 2, prompt: "Password", activityId: null });
    queue.respond(1, "alice");
    queue.respond(1, "alice");
    queue.releaseInactive(new Set());
    expect(answer.mock.calls).toEqual([[1, "alice"]]);
    expect(queue.getSnapshot().map((item) => item.id)).toEqual([2]);
  });

  it("clears the queue and releases remaining requests when the dialog unmounts", () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const queue = createAskpassQueue(answer);
    queue.enqueue({ id: 1, prompt: "Password", activityId: "repo-a-fetch" });
    queue.enqueue({ id: 2, prompt: "Username", activityId: null });
    queue.dispose();
    queue.dispose();
    expect(queue.getSnapshot()).toEqual([]);
    expect(answer.mock.calls).toEqual([[1, null], [2, null]]);
  });

  it("cancels the owning activity before releasing a cancelled prompt and ignores duplicate clicks", async () => {
    let finishCancel!: () => void;
    const stopping = new Promise<void>((resolve) => { finishCancel = resolve; });
    const answer = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockReturnValue(stopping);
    const queue = createAskpassQueue(answer, cancel);
    queue.enqueue({ id: 1, prompt: "Username", activityId: "repo-a-fetch" });
    queue.enqueue({ id: 2, prompt: "Password", activityId: "repo-b-fetch" });
    const response = queue.respond(1, null);
    await queue.respond(1, null);
    queue.releaseInactive(new Set(["repo-b-fetch"]));
    expect(cancel.mock.calls).toEqual([["repo-a-fetch"]]);
    expect(answer).not.toHaveBeenCalled();
    expect(queue.getSnapshot().map((item) => item.id)).toEqual([2]);
    finishCancel();
    await response;
    expect(answer.mock.calls).toEqual([[1, null]]);
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(answer.mock.invocationCallOrder[0]);
  });

  it("releases a prompt even when its activity cancellation fails", async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockRejectedValue(new Error("Cancellation failed"));
    const queue = createAskpassQueue(answer, cancel);
    queue.enqueue({ id: 1, prompt: "Username", activityId: "repo-a-fetch" });
    await queue.respond(1, null);
    expect(cancel).toHaveBeenCalledWith("repo-a-fetch");
    expect(answer).toHaveBeenCalledWith(1, null);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("only releases an unowned prompt and does not cancel activities for submitted answers", async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const queue = createAskpassQueue(answer, cancel);
    queue.enqueue({ id: 1, prompt: "Username", activityId: null });
    queue.enqueue({ id: 2, prompt: "Username", activityId: "repo-b-fetch" });
    await queue.respond(1, null);
    await queue.respond(2, "alice");
    expect(cancel).not.toHaveBeenCalled();
    expect(answer.mock.calls).toEqual([[1, null], [2, "alice"]]);
  });
});
