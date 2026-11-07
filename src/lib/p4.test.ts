import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { invoke } from "@tauri-apps/api/core";
import { isP4Missing, P4_MISSING, p4Api, relativeToRoot, subscribeP4Availability, syncSummary } from "./p4";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const initialLanguage = i18n.language;
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage(initialLanguage);
});

it("reports a missing p4 executable and clears the notice after a successful discovery", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(P4_MISSING);
  await expect(p4Api.open("/work/client")).rejects.toBe(P4_MISSING);
  // Discovery can fail before the banner mounts; its initial snapshot must retain it.
  expect(isP4Missing()).toBe(true);
  const missing: boolean[] = [];
  const unsubscribe = subscribeP4Availability(() => missing.push(isP4Missing()));
  vi.mocked(invoke).mockResolvedValueOnce({ pathP4: "/usr/bin/p4", active: "/usr/bin/p4" });
  await p4Api.executables();
  unsubscribe();
  expect(missing).toEqual([false]);
  expect(isP4Missing()).toBe(false);
});

it("keeps case-sensitive workspace boundaries and rejects parent traversal", () => {
  expect(relativeToRoot("/work/client", "/work/client/src/file.txt", false)).toBe("src/file.txt");
  expect(relativeToRoot("/work/client", "/work/Client/src/file.txt", false)).toBe("");
  expect(relativeToRoot("/work/client", "/work/client-other/file.txt", false)).toBe("");
  expect(relativeToRoot("/work/client", "/work/client/../outside.txt", false)).toBe("");
  expect(relativeToRoot("/work/client", "/work/client/a\\b.txt", false)).toBe("a\\b.txt");
  expect(relativeToRoot("C:\\work\\client", "c:/WORK/client/src/file.txt", true)).toBe("src/file.txt");
});

it("cancels only the depot search belonging to the supplied connection", async () => {
  const connection = {
    root: "C:\\work\\client", port: "ssl:perforce.example.com:1666", user: "alice", client: "dev-pc",
    charset: "utf8", stream: null, server: "",
  };
  await p4Api.cancelDepotSearch(connection);
  expect(invoke).toHaveBeenLastCalledWith("p4_cancel_depot_search", { connection });
});

describe("syncSummary", () => {
  it("localizes the summary without changing how CLI output is counted", async () => {
    await i18n.changeLanguage("zh-CN");
    const summary = syncSummary("//depot/a.txt#2 - updating C:\\work\\a.txt");
    expect(summary).toContain("1");
    expect(summary).not.toMatch(/updated|file|p4\./i);
    expect(summary).not.toContain("//depot/");
  });
  it("counts updated, added, and deleted files", () => {
    const output = [
      "//depot/a.txt#2 - updating E:\\a.txt",
      "//depot/b.txt#3 - refreshing E:\\b.txt",
      "//depot/c.txt#1 - added as E:\\c.txt",
      "//depot/d.txt#4 - deleted as E:\\d.txt",
      "//depot/e.txt#1 - moved from E:\\old.txt",
    ].join("\n");
    expect(syncSummary(output)).toBe("Updated 3 files, added 1 file, deleted 1 file.");
  });

  it("uses the singular when one file moved", () => {
    expect(syncSummary("//depot/a.txt#2 - updating E:\\a.txt")).toBe("Updated 1 file.");
  });

  it("says up to date when nothing was transferred", () => {
    expect(syncSummary("file(s) up-to-date.\n")).toBe("Up to date");
    expect(syncSummary("")).toBe("Up to date");
  });
});
