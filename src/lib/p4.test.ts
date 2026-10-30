import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { p4Api, syncSummary } from "./p4";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

it("cancels only the depot search belonging to the supplied connection", async () => {
  const connection = {
    root: "C:\\work\\client", port: "ssl:perforce.example.com:1666", user: "alice", client: "dev-pc",
    charset: "utf8", stream: null, server: "",
  };
  await p4Api.cancelDepotSearch(connection);
  expect(invoke).toHaveBeenLastCalledWith("p4_cancel_depot_search", { connection });
});

describe("syncSummary", () => {
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
