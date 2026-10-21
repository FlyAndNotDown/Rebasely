import { describe, expect, it } from "vitest";
import { syncSummary } from "./p4";

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
