import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_LAYOUTS,
  defaultPrefs,
  normalizeHistoryShell,
  normalizeLayout,
  normalizePanelLayouts,
  normalizePrefs,
  normalizeSidebarOrder,
  sameGitPath,
  sameLayout,
  sameP4Path,
} from "./prefs";

const changes = DEFAULT_PANEL_LAYOUTS.changes;

describe("normalizeSidebarOrder", () => {
  it("drops unknown or repeated views and appends the missing ones", () => {
    expect(normalizeSidebarOrder(null)).toEqual(["changes", "history", "stash", "files"]);
    expect(normalizeSidebarOrder(["files", "files", "nope", "history"])).toEqual([
      "files",
      "history",
      "changes",
      "stash",
    ]);
  });
});

describe("layouts", () => {
  it("treats layouts as equal after rounding", () => {
    expect(sameLayout({ a: 33.333, b: 66.667 }, { a: 33.33, b: 66.67 })).toBe(true);
    expect(sameLayout(null, {})).toBe(true);
    expect(sameLayout({ a: 40 }, { a: 60 })).toBe(false);
  });

  it("keeps a layout near 100 and rejects a broken one", () => {
    expect(normalizeLayout({ "changes-files": 40, "changes-diff": 60 }, changes)).toEqual({
      "changes-files": 40,
      "changes-diff": 60,
    });
    expect(normalizeLayout({ "changes-files": 46, "changes-diff": 46 }, changes)).toEqual({
      "changes-files": 46,
      "changes-diff": 46,
    });
    expect(normalizeLayout({ "changes-files": 45, "changes-diff": 46 }, changes)).toEqual(changes);
    expect(normalizeLayout({ "changes-files": 0, "changes-diff": 100 }, changes)).toEqual(changes);
    expect(normalizeLayout(null, changes)).toEqual(changes);
    expect(normalizeLayout(null, changes)).not.toBe(changes);
  });

  it("clamps the history branch column and recomputes the remainder", () => {
    expect(normalizeHistoryShell({ "history-branches": 20, "history-main": 80 })).toEqual({
      "history-branches": 20,
      "history-main": 80,
    });
    expect(normalizeHistoryShell({ "history-branches": 11, "history-main": 89 })).toEqual(
      DEFAULT_PANEL_LAYOUTS.historyShell,
    );
    expect(normalizeHistoryShell({ "history-branches": 33, "history-main": 67 })).toEqual(
      DEFAULT_PANEL_LAYOUTS.historyShell,
    );
  });

  it("fills each pane from its own fallback", () => {
    const layouts = normalizePanelLayouts({
      changes: { "changes-files": 50, "changes-diff": 50 },
    });
    expect(layouts.changes).toEqual({ "changes-files": 50, "changes-diff": 50 });
    expect(layouts.history).toEqual(DEFAULT_PANEL_LAYOUTS.history);
    expect(layouts.files).toEqual(DEFAULT_PANEL_LAYOUTS.files);
  });
});

describe("normalizePrefs", () => {
  it("fills defaults and only accepts real booleans", () => {
    expect(normalizePrefs(null)).toEqual(defaultPrefs);
    expect(
      normalizePrefs({
        terminalId: "",
        editorId: "auto",
        pullRebase: true,
        changesTree: true,
        autoFetchMinutes: 14.6,
        fetchPrune: true,
      }),
    ).toMatchObject({
      terminalId: "auto",
      editorId: "system",
      pullRebase: true,
      changesTree: true,
      diffSplit: false,
      diffIgnoreWhitespace: false,
      autoFetchMinutes: 15,
      fetchPrune: true,
    });
  });

  it("keeps added git executables and drops other file names", () => {
    expect(
      normalizePrefs({
        gitPath: "  /usr/bin/git  ",
        extraGitPaths: [
          "C:/Git/cmd/git.exe",
          "C:\\Git\\cmd\\git.exe",
          "C:/Git/cmd/git-lfs.exe",
          "/usr/bin/git",
          "gitk",
          "",
        ],
      }),
    ).toMatchObject({
      gitPath: "/usr/bin/git",
      extraGitPaths: ["C:/Git/cmd/git.exe", "/usr/bin/git"],
    });
    expect(normalizePrefs({ gitPath: "gitk.exe" }).gitPath).toBe("");
    expect(normalizePrefs(null).extraGitPaths).toEqual([]);
    expect(sameGitPath("C:/Git/cmd/git.exe", "C:\\Git\\cmd\\git.exe")).toBe(true);
  });

  it("keeps added p4 executables and a known charset", () => {
    expect(
      normalizePrefs({
        p4Path: "  C:/Perforce/p4.exe  ",
        extraP4Paths: ["C:/Perforce/p4.exe", "C:/Perforce/p4v.exe", "p4"],
        p4Port: " ssl:perforce.example.com:1666\n",
        p4User: " ada ",
        p4Charset: "UTF8",
      }),
    ).toMatchObject({
      p4Path: "C:/Perforce/p4.exe",
      extraP4Paths: ["C:/Perforce/p4.exe", "p4"],
      p4Port: "ssl:perforce.example.com:1666",
      p4User: "ada",
      p4Charset: "utf8",
    });
    expect(normalizePrefs({ p4Charset: "latin1" }).p4Charset).toBe("");
    expect(sameP4Path("C:/Perforce/p4.exe", "C:\\Perforce\\p4.exe")).toBe(true);
  });

  it("keeps a chosen editor and rejects a negative fetch interval", () => {
    expect(normalizePrefs({ editorId: "code", autoFetchMinutes: -1 })).toMatchObject({
      editorId: "code",
      autoFetchMinutes: defaultPrefs.autoFetchMinutes,
    });
    expect(normalizePrefs({ autoFetchMinutes: 0 }).autoFetchMinutes).toBe(0);
  });
});
