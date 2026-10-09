import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disambiguateRepoLabels,
  displayPath,
  fileName,
  formatAbsoluteTime,
  formatRelativeTime,
  normalizeRepoPath,
  parentPath,
  pathSegments,
  sameRepoPath,
} from "./format";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 9, 9, 12, 0, 0);

  function ago(ms: number) {
    return Math.floor((now.getTime() - ms) / 1000);
  }

  it("counts recent times and falls back to a date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(formatRelativeTime(ago(-5_000))).toBe("just now");
    expect(formatRelativeTime(ago(30_000))).toBe("just now");
    expect(formatRelativeTime(ago(5 * 60_000))).toBe("5m ago");
    expect(formatRelativeTime(ago(3 * 60 * 60_000))).toBe("3h ago");
    expect(formatRelativeTime(ago(2 * 24 * 60 * 60_000))).toBe("2d ago");
    expect(formatRelativeTime(ago(7 * 24 * 60 * 60_000))).toBe("Oct 2");
    expect(formatRelativeTime(Math.floor(new Date(2025, 11, 1, 12).getTime() / 1000))).toBe("Dec 1, 2025");
  });
});

describe("formatAbsoluteTime", () => {
  it("prints the local date and minute", () => {
    const stamp = Math.floor(new Date(2026, 0, 5, 9, 7).getTime() / 1000);
    expect(formatAbsoluteTime(stamp)).toBe("2026-01-05 09:07");
  });
});

describe("paths", () => {
  it("takes the file name and parent from slash-separated paths", () => {
    expect(fileName("src/lib/a.ts")).toBe("a.ts");
    expect(fileName("a.ts")).toBe("a.ts");
    expect(parentPath("src/lib/a.ts")).toBe("src/lib");
    expect(parentPath("a.ts")).toBe("");
  });

  it("strips the Windows verbatim prefix and compares repos case-insensitively", () => {
    expect(displayPath("\\\\?\\C:\\work\\Repo")).toBe("C:\\work\\Repo");
    expect(displayPath("\\\\?\\UNC\\server\\share\\repo")).toBe("\\\\server\\share\\repo");
    expect(normalizeRepoPath("C:/work/Repo/")).toBe("c:\\work\\repo");
    expect(normalizeRepoPath("\\\\?\\C:\\work\\Repo\\")).toBe("c:\\work\\repo");
    expect(sameRepoPath("C:/work/Repo", "c:\\work\\repo\\")).toBe(true);
    expect(sameRepoPath("C:/work/Repo", "C:/work/Other")).toBe(false);
  });

  it("splits either slash and drops a trailing separator", () => {
    expect(pathSegments("\\\\?\\C:\\work\\Repo\\")).toEqual(["C:", "work", "Repo"]);
    expect(pathSegments("\\\\?\\UNC\\server\\share")).toEqual(["server", "share"]);
  });
});

describe("disambiguateRepoLabels", () => {
  it("leaves unique names alone and adds parents until names differ", () => {
    const shallow = disambiguateRepoLabels([
      { path: "E:\\only\\app", name: "app" },
      { path: "E:\\a\\repo", name: "repo" },
      { path: "E:\\b\\repo", name: "repo" },
    ]);
    expect(shallow.get("E:\\only\\app")).toBe("app");
    expect(shallow.get("E:\\a\\repo")).toBe("repo (a)");
    expect(shallow.get("E:\\b\\repo")).toBe("repo (b)");

    const deeper = disambiguateRepoLabels([
      { path: "E:\\x\\a\\repo", name: "" },
      { path: "E:\\y\\a\\repo", name: "" },
    ]);
    expect(deeper.get("E:\\x\\a\\repo")).toBe("repo (x/a)");
    expect(deeper.get("E:\\y\\a\\repo")).toBe("repo (y/a)");
  });

  it("keeps a one-segment path as its own name", () => {
    const labels = disambiguateRepoLabels([
      { path: "repo", name: "repo" },
      { path: "E:\\other\\repo", name: "repo" },
    ]);
    expect(labels.get("repo")).toBe("repo");
    expect(labels.get("E:\\other\\repo")).toBe("repo (other)");
  });
});
