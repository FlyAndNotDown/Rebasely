import { describe, expect, it } from "vitest";
import { reconcileChangeSelection } from "./change-selection";
import type { FileStatus } from "@/types/git";

const selected = { type: "change" as const, path: "pixel.png", staged: false };
const file = (path: string, staged: boolean): FileStatus => ({ path, staged, kind: "modified", oldPath: null });

describe("change selection after a repository operation", () => {
  it("follows the selected file after stage all or unstage all", () => {
    const staged = reconcileChangeSelection(selected, { staged: [file("pixel.png", true)], unstaged: [] });
    expect(staged).toEqual({ ...selected, staged: true });
    expect(reconcileChangeSelection(staged, { staged: [], unstaged: [file("pixel.png", false)] })).toEqual(selected);
  });

  it("keeps the original scope when a partially staged file remains there", () => {
    expect(reconcileChangeSelection(selected, { staged: [file("pixel.png", true)], unstaged: [file("pixel.png", false)] })).toBe(selected);
  });

  it("clears a committed or discarded selection without choosing a different file", () => {
    expect(reconcileChangeSelection({ ...selected, staged: true }, { staged: [], unstaged: [] })).toBeNull();
    expect(reconcileChangeSelection(selected, { staged: [], unstaged: [file("other.png", false)] })).toBeNull();
    expect(reconcileChangeSelection(null, { staged: [file("pixel.png", true)], unstaged: [] })).toBeNull();
  });
});
