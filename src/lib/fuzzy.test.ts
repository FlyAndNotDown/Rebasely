import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";
import { formatCombo, matchesCombo } from "./shortcuts";

describe("fuzzyScore", () => {
  it("prefers word-start substrings over scattered letters", () => {
    const direct = fuzzyScore("push", "Push to origin")!;
    const scattered = fuzzyScore("psh", "Push to origin")!;
    expect(direct).toBeGreaterThan(scattered);
    expect(fuzzyScore("pull", "Pull with rebase")!).toBeGreaterThan(fuzzyScore("pull", "Undo pulling")!);
  });

  it("needs every word and returns null otherwise", () => {
    expect(fuzzyScore("branch main", "Switch to branch main")).not.toBeNull();
    expect(fuzzyScore("branch zzz", "Switch to branch main")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("shortcuts", () => {
  const event = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  });

  it("matches modifiers exactly", () => {
    expect(matchesCombo(event("F", { ctrlKey: true, shiftKey: true }), { key: "f", mod: true, shift: true }, false)).toBe(true);
    expect(matchesCombo(event("f", { ctrlKey: true }), { key: "f", mod: true, shift: true }, false)).toBe(false);
    expect(matchesCombo(event("k", { metaKey: true }), { key: "k", mod: true }, true)).toBe(true);
  });

  it("formats for Windows and macOS", () => {
    expect(formatCombo({ key: "f", mod: true, shift: true }, false)).toBe("Ctrl+Shift+F");
    expect(formatCombo({ key: "f", mod: true, shift: true }, true)).toBe("⌘⇧F");
  });
});
