import { describe, expect, it } from "vitest";
import { formatCombo, isPlatformModifier, matchesCombo } from "./shortcuts";

const key = { key: "K", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

describe("platform keyboard shortcuts", () => {
  it("uses Command on macOS and Control on Windows and Linux", () => {
    expect(matchesCombo({ ...key, metaKey: true }, { key: "k", mod: true }, true)).toBe(true);
    expect(matchesCombo({ ...key, ctrlKey: true }, { key: "k", mod: true }, true)).toBe(false);
    expect(matchesCombo({ ...key, ctrlKey: true }, { key: "k", mod: true }, false)).toBe(true);
    expect(matchesCombo({ ...key, metaKey: true }, { key: "k", mod: true }, false)).toBe(false);
  });

  it("rejects additional modifiers instead of triggering another action", () => {
    expect(matchesCombo({ ...key, ctrlKey: true, metaKey: true }, { key: "k", mod: true }, false)).toBe(false);
    expect(matchesCombo({ ...key, ctrlKey: true, shiftKey: true }, { key: "k", mod: true }, false)).toBe(false);
    expect(matchesCombo({ ...key, ctrlKey: true, altKey: true }, { key: "k", mod: true }, false)).toBe(false);
    expect(matchesCombo({ ...key, key: "F1" }, { key: "F1" }, true)).toBe(true);
  });

  it("uses the same modifier policy for WebView shortcut suppression", () => {
    expect(isPlatformModifier({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(isPlatformModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isPlatformModifier({ ctrlKey: true, metaKey: true }, true)).toBe(false);
  });

  it("renders the platform's visible chord", () => {
    expect(formatCombo({ key: "f", mod: true, shift: true }, true)).toBe("⌘⇧F");
    expect(formatCombo({ key: "f", mod: true, shift: true }, false)).toBe("Ctrl+Shift+F");
  });
});
