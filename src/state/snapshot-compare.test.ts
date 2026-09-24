import { describe, expect, it } from "vitest";
import type { FileDiff, WorkspaceSnapshot } from "@/types/git";
import {
  historyGraphChanged,
  keepRemoteBranches,
  mergeRefreshHint,
  progressFromGitLine,
  sameDiff,
  sameRevs,
  sameSnapshot,
  shouldReloadWorkdirDiff,
} from "./snapshot-compare";

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    repo: {
      path: "E:\\repo",
      name: "repo",
      currentBranch: "main",
      headId: "a1",
      isDetached: false,
      ahead: 0,
      behind: 0,
      upstream: "origin/main",
      rebase: null,
      operation: null,
    },
    status: { staged: [], unstaged: [] },
    branches: { current: "main", isDetached: false, local: [], remote: [], tags: [] },
    remotes: [],
    stashes: [],
    headCommit: null,
    ...overrides,
  };
}

function diff(lines: string[]): FileDiff {
  return {
    path: "a.txt",
    oldPath: null,
    binary: false,
    truncated: false,
    lines: lines.map((content, index) => ({
      kind: "add",
      content,
      oldLineno: null,
      newLineno: index + 1,
    })),
  };
}

describe("sameSnapshot", () => {
  it("treats a structurally equal snapshot as the same", () => {
    expect(sameSnapshot(snapshot(), snapshot())).toBe(true);
  });

  it("notices a new unstaged file, a moved HEAD, and a new stash", () => {
    const base = snapshot();
    const file = { path: "a.txt", oldPath: null, kind: "modified", staged: false };
    expect(sameSnapshot(base, snapshot({ status: { staged: [], unstaged: [file] } }))).toBe(false);
    expect(sameSnapshot(base, snapshot({ repo: { ...base.repo, headId: "b2" } }))).toBe(false);
    expect(sameSnapshot(base, snapshot({ stashes: [{ index: 0, message: "wip", id: "s1" }] }))).toBe(false);
  });

  it("is never the same as a missing snapshot", () => {
    expect(sameSnapshot(null, snapshot())).toBe(false);
  });
});

describe("sameDiff", () => {
  it("compares line content, not identity", () => {
    expect(sameDiff(diff(["a", "b"]), diff(["a", "b"]))).toBe(true);
    expect(sameDiff(diff(["a", "b"]), diff(["a", "c"]))).toBe(false);
    expect(sameDiff(null, diff([]))).toBe(false);
    expect(sameDiff(null, null)).toBe(true);
  });
});

describe("keepRemoteBranches", () => {
  it("keeps previously loaded remote branches when the refresh skipped them", () => {
    const remote = [{ name: "origin/main", isHead: false, isRemote: true, upstream: null }];
    const previous = snapshot({ branches: { ...snapshot().branches, remote } });
    expect(keepRemoteBranches(previous, snapshot()).branches.remote).toBe(remote);
  });

  it("uses the new list when the refresh has one", () => {
    const fresh = [{ name: "origin/dev", isHead: false, isRemote: true, upstream: null }];
    const next = snapshot({ branches: { ...snapshot().branches, remote: fresh } });
    expect(keepRemoteBranches(snapshot(), next)).toBe(next);
  });
});

describe("historyGraphChanged", () => {
  it("changes when HEAD or the upstream distance moves", () => {
    const base = snapshot();
    expect(historyGraphChanged(base, snapshot())).toBe(false);
    expect(historyGraphChanged(base, snapshot({ repo: { ...base.repo, behind: 2 } }))).toBe(true);
    expect(historyGraphChanged(undefined, base)).toBe(true);
  });
});

describe("refresh hints", () => {
  it("merges paths without duplicates and overflows past the cap", () => {
    const hint = { paths: ["a"], overflow: false };
    mergeRefreshHint(hint, { paths: ["a", "b"], overflow: false });
    expect(hint).toEqual({ paths: ["a", "b"], overflow: false });
    mergeRefreshHint(hint, { paths: Array.from({ length: 60 }, (_, n) => `f${n}`), overflow: false });
    expect(hint).toEqual({ paths: [], overflow: true });
  });

  it("reloads the selected diff only when its file or .git changed", () => {
    const repo = "E:/repo";
    const only = (paths: string[]) => ({ paths, overflow: false });
    expect(shouldReloadWorkdirDiff(only(["E:\\repo\\src\\a.ts"]), repo, "src/a.ts")).toBe(true);
    expect(shouldReloadWorkdirDiff(only(["E:\\repo\\src\\b.ts"]), repo, "src/a.ts")).toBe(false);
    expect(shouldReloadWorkdirDiff(only(["E:\\repo\\.git\\index"]), repo, "src/a.ts")).toBe(true);
    expect(shouldReloadWorkdirDiff({ paths: [], overflow: true }, repo, "src/a.ts")).toBe(true);
  });
});

describe("small helpers", () => {
  it("reads git progress percentages", () => {
    expect(progressFromGitLine("Receiving objects:  42% (420/1000)")).toBe(42);
    expect(progressFromGitLine("remote: Counting objects")).toBeUndefined();
  });

  it("compares rev lists ignoring order", () => {
    expect(sameRevs(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameRevs(["a"], ["a", "b"])).toBe(false);
  });
});
