import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@/types/git";
import {
  WELCOME_TAB_ID,
  defaultFetchRemote,
  findRepoTab,
  lookupPathList,
  primaryRemote,
  reorderAppTabs,
  tabFromPath,
  type AppTab,
} from "./session";

function withRemotes(names: string[], upstream: string | null = null) {
  return {
    repo: { upstream },
    remotes: names.map((name) => ({ name, url: null, pushUrl: null })),
  } as unknown as WorkspaceSnapshot;
}

describe("remotes", () => {
  it("fetches from the upstream's remote, preferring the longest matching name", () => {
    expect(defaultFetchRemote(withRemotes(["origin", "origin-mirror"], "origin-mirror/main"))).toBe(
      "origin-mirror",
    );
    expect(defaultFetchRemote(withRemotes(["origin", "fork"], "fork/feature"))).toBe("fork");
  });

  it("falls back to origin, or nothing", () => {
    expect(defaultFetchRemote(withRemotes(["fork", "origin"]))).toBe("origin");
    expect(defaultFetchRemote(withRemotes(["fork"]))).toBeUndefined();
  });

  it("picks origin as the primary remote, else the first", () => {
    expect(primaryRemote(withRemotes(["fork", "origin"]))).toBe("origin");
    expect(primaryRemote(withRemotes(["fork", "upstream"]))).toBe("fork");
    expect(primaryRemote(null)).toBeUndefined();
  });
});

describe("tabs", () => {
  const tabs: AppTab[] = [
    { id: WELCOME_TAB_ID, kind: "welcome" },
    tabFromPath("E:\\a"),
    tabFromPath("E:\\b"),
    tabFromPath("E:\\c"),
  ];

  it("moves a tab before or after another", () => {
    const ids = (list: AppTab[]) => list.map((tab) => tab.id);
    expect(ids(reorderAppTabs(tabs, "repo:E:\\c", "repo:E:\\a", "before"))).toEqual([
      WELCOME_TAB_ID,
      "repo:E:\\c",
      "repo:E:\\a",
      "repo:E:\\b",
    ]);
    expect(ids(reorderAppTabs(tabs, "repo:E:\\a", "repo:E:\\c", "after"))).toEqual([
      WELCOME_TAB_ID,
      "repo:E:\\b",
      "repo:E:\\c",
      "repo:E:\\a",
    ]);
  });

  it("returns the same array when nothing moves", () => {
    expect(reorderAppTabs(tabs, "repo:E:\\a", "repo:E:\\b", "before")).toBe(tabs);
    expect(reorderAppTabs(tabs, "missing", "repo:E:\\b", "before")).toBe(tabs);
  });

  it("finds a repo tab regardless of slash direction and case", () => {
    expect(findRepoTab(tabs, "e:/B/")?.id).toBe("repo:E:\\b");
    expect(tabFromPath("E:\\code\\rebasely").name).toBe("rebasely");
  });
});

describe("lookupPathList", () => {
  it("matches the stored key by normalized path", () => {
    const map = { "E:\\Repo": ["main"] };
    expect(lookupPathList(map, "e:/repo")).toEqual(["main"]);
    expect(lookupPathList(map, "E:\\other")).toBeNull();
  });
});
