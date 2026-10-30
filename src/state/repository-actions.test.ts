import { describe, expect, it, vi } from "vitest";
import { orderReplayCommits, replayCommitBatch, repositoryUndoAction } from "./repository-actions";

describe("repository-owned delayed actions", () => {
  it("undoes the repository that created a notification after switching tabs", () => {
    let activeTabId = "repo-a";
    const heads = new Map([["repo-a", "a2"], ["repo-b", "b2"]]);
    const undo = vi.fn(async (tabId = activeTabId) => {
      heads.set(tabId, tabId === "repo-a" ? "a1" : "b1");
      return true;
    });
    const action = repositoryUndoAction(activeTabId, undo);
    activeTabId = "repo-b";
    action.onClick();
    expect(undo).toHaveBeenCalledWith("repo-a");
    expect(heads.get("repo-a")).toBe("a1");
    expect(heads.get("repo-b")).toBe("b2");
  });

  it("keeps a sequential batch on its original repository across asynchronous tab switches", async () => {
    let activeTabId = "repo-a";
    let finishFirst!: (value: boolean) => void;
    const first = new Promise<boolean>((resolve) => { finishFirst = resolve; });
    const replay = vi.fn(async (_oid: string, tabId = activeTabId) => {
      if (replay.mock.calls.length === 1) return first;
      expect(tabId).toBe("repo-a");
      return true;
    });
    const result = replayCommitBatch(activeTabId, [{ id: "first" }, { id: "second" }], replay);
    expect(replay).toHaveBeenCalledOnce();
    activeTabId = "repo-b";
    finishFirst(true);
    await expect(result).resolves.toBe(true);
    expect(replay.mock.calls).toEqual([["first", "repo-a"], ["second", "repo-a"]]);
  });

  it("stops the batch on a conflict, failure, or closed repository", async () => {
    const replay = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(replayCommitBatch("repo-a", [{ id: "first" }, { id: "conflict" }, { id: "unreached" }], replay)).resolves.toBe(false);
    expect(replay.mock.calls).toEqual([["first", "repo-a"], ["conflict", "repo-a"]]);
  });
});

describe("commit replay order", () => {
  it.each([
    { parentTime: 100, childTime: 100 },
    { parentTime: 200, childTime: 100 },
  ])("cherry-picks dependent commits in Git ancestry order with timestamps $parentTime/$childTime", async ({ parentTime, childTime }) => {
    const displayed = [
      { id: "child", parents: ["parent"], timestamp: childTime },
      { id: "parent", parents: ["base"], timestamp: parentTime },
    ];
    const execution = orderReplayCommits(displayed, "cherry-pick");
    expect(execution.map((commit) => commit.id)).toEqual(["parent", "child"]);
    let contents = "base";
    const replay = vi.fn(async (id: string) => {
      if (id === "parent" && contents === "base") { contents = "parent"; return true; }
      if (id === "child" && contents === "parent") { contents = "child"; return true; }
      return false;
    });
    await expect(replayCommitBatch("repo-a", execution, replay)).resolves.toBe(true);
    expect(contents).toBe("child");
    expect(displayed.map((commit) => commit.id)).toEqual(["child", "parent"]);
  });

  it("reverts children before their parents without changing the displayed history array", async () => {
    const displayed = [{ id: "child", timestamp: 100 }, { id: "parent", timestamp: 200 }];
    const execution = orderReplayCommits(displayed, "revert");
    expect(execution.map((commit) => commit.id)).toEqual(["child", "parent"]);
    const replay = vi.fn().mockResolvedValue(true);
    await replayCommitBatch("repo-a", execution, replay);
    expect(replay.mock.calls).toEqual([["child", "repo-a"], ["parent", "repo-a"]]);
    expect(execution).not.toBe(displayed);
    expect(displayed.map((commit) => commit.id)).toEqual(["child", "parent"]);
  });
});
