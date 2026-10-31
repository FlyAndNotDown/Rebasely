import { describe, expect, it } from "vitest";
import type { BranchInfo } from "@/types/git";
import { emptyBinaryDiff, errorMessage, expandHistoryRevs, isCancelled, isRemoteTrackingBranch } from "./git";

function branch(name: string, upstream: string | null): BranchInfo {
  return { name, isHead: false, isRemote: false, upstream };
}

describe("isRemoteTrackingBranch", () => {
  it("accepts remote-qualified names and rejects HEAD or a remote itself", () => {
    expect(isRemoteTrackingBranch("origin/main")).toBe(true);
    expect(isRemoteTrackingBranch("  origin/main  ")).toBe(true);
    expect(isRemoteTrackingBranch("main")).toBe(false);
    expect(isRemoteTrackingBranch("origin/HEAD")).toBe(false);
    expect(isRemoteTrackingBranch("HEAD")).toBe(false);
    expect(isRemoteTrackingBranch("origin/main", ["origin/main"])).toBe(false);
    expect(isRemoteTrackingBranch("Origin", ["origin"])).toBe(false);
    expect(isRemoteTrackingBranch("Origin/Main", ["origin"])).toBe(true);
  });
});

describe("expandHistoryRevs", () => {
  const locals = [branch("main", "origin/main"), branch("topic", null), branch("other", "fork/other")];

  it("adds the upstream of each selected local branch once", () => {
    expect(expandHistoryRevs(null)).toEqual([]);
    expect(expandHistoryRevs(["main", "topic"], locals)).toEqual(["main", "topic", "origin/main"]);
    expect(expandHistoryRevs(["main", "origin/main"], locals)).toEqual(["main", "origin/main"]);
    expect(expandHistoryRevs(["absent"], locals)).toEqual(["absent"]);
  });
});

describe("errors and empty diffs", () => {
  it("reads a message from a string or an Error", () => {
    expect(errorMessage("missing")).toBe("missing");
    expect(errorMessage(new Error("broken"))).toBe("broken");
    expect(errorMessage(404)).toBe("404");
  });

  it("matches only the backend cancellation string", () => {
    expect(isCancelled(new Error("Cancelled"))).toBe(true);
    expect(isCancelled("Cancelled")).toBe(true);
    expect(isCancelled(new Error("cancelled"))).toBe(false);
    expect(isCancelled(new Error("not fully merged"))).toBe(false);
  });

  it("builds a binary diff with no lines", () => {
    expect(emptyBinaryDiff("pic.png")).toEqual({
      path: "pic.png",
      oldPath: null,
      binary: true,
      truncated: false,
      lines: [],
    });
    expect(emptyBinaryDiff("pic.png", "old.png").oldPath).toBe("old.png");
  });
});
