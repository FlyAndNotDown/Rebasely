import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@/types/git";
import {
  WELCOME_TAB_ID,
  defaultFetchRemote,
  findRepoTab,
  lookupPathList,
  placeOpenedRepoTab,
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

  it("reads the remote from an upstream that is not configured yet", () => {
    expect(defaultFetchRemote(withRemotes(["origin"], "fork/feature"))).toBe("fork");
    expect(defaultFetchRemote(withRemotes([], "fork/feature"))).toBe("fork");
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

  it("keeps Git and Perforce of the same folder as different tabs", () => {
    const git = tabFromPath("E:\\client");
    const perforce = tabFromPath("E:\\client", "client", "perforce");
    expect(git.id).toBe("repo:E:\\client");
    expect(perforce.id).toBe("p4:E:\\client");
    const open = placeOpenedRepoTab(placeOpenedRepoTab([], git), perforce);
    expect(open.map((tab) => tab.id)).toEqual([git.id, perforce.id]);
    expect(findRepoTab(open, "E:\\client", "perforce")?.id).toBe(perforce.id);
    expect(findRepoTab(open, "E:\\client", "git")?.id).toBe(git.id);
  });
});

describe("opening into tabs", () => {
  const welcome: AppTab = { id: WELCOME_TAB_ID, kind: "welcome" };
  const repoA = tabFromPath("E:\\a");
  const repoB = tabFromPath("E:\\b");

  it("appends a repository and drops the welcome page from the strip", () => {
    expect(placeOpenedRepoTab([welcome, repoA], repoB).map((tab) => tab.id)).toEqual([
      repoA.id,
      repoB.id,
    ]);
    expect(placeOpenedRepoTab([repoA], repoB).map((tab) => tab.id)).toEqual([repoA.id, repoB.id]);
  });

  it("keeps an open repository where it is and drops the welcome page", () => {
    expect(placeOpenedRepoTab([repoA, welcome], repoA)).toEqual([repoA]);
  });

  it("leaves an already open repository where it is", () => {
    const open = [repoA];
    expect(placeOpenedRepoTab(open, repoA)).toBe(open);
  });
});

describe("lookupPathList", () => {
  it("matches the stored key by normalized path", () => {
    const map = { "E:\\Repo": ["main"] };
    expect(lookupPathList(map, "e:/repo")).toEqual(["main"]);
    expect(lookupPathList(map, "E:\\other")).toBeNull();
  });
});
