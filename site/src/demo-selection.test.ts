import { describe, expect, it } from "vitest";
import { demoFiles } from "./demo-data";
import { reconcileDemoSelection } from "./demo-selection";

const navigation = demoFiles[0];
const theme = demoFiles[1];
const navigationHunks = navigation.hunks.map((hunk) => hunk.id);
const themeHunk = theme.hunks[0].id;

describe("demo change selection", () => {
  it("keeps the current scope while the selected file still has changes there", () => {
    const selected = { fileId: navigation.id, scope: "staged" as const };
    expect(reconcileDemoSelection(demoFiles, new Set(navigationHunks), new Set([navigationHunks[0]]), selected)).toBe(selected);
  });

  it("follows the same file back to unstaged after committing only one hunk", () => {
    const remaining = new Set([navigationHunks[1], themeHunk]);
    expect(reconcileDemoSelection(demoFiles, remaining, new Set(), { fileId: navigation.id, scope: "staged" })).toEqual({ fileId: navigation.id, scope: "unstaged" });
  });

  it("selects the next changed file when the selected file was fully committed", () => {
    expect(reconcileDemoSelection(demoFiles, new Set([themeHunk]), new Set(), { fileId: navigation.id, scope: "staged" })).toEqual({ fileId: theme.id, scope: "unstaged" });
  });

  it("shows the clean state after committing all remaining hunks", () => {
    expect(reconcileDemoSelection(demoFiles, new Set(), new Set(), { fileId: navigation.id, scope: "staged" })).toBeNull();
  });
});
