import { describe, expect, it } from "vitest";
import { avatarColor, avatarHue, avatarInitial, avatarSeed } from "./avatar";

describe("avatar", () => {
  it("falls back from name to email to a placeholder", () => {
    expect(avatarSeed(" Ada ", "ada@example.com")).toBe("Ada");
    expect(avatarSeed("", "ada@example.com")).toBe("ada@example.com");
    expect(avatarSeed(" ", "")).toBe("user");
  });

  it("uses the first letter or digit", () => {
    expect(avatarInitial("ada")).toBe("A");
    expect(avatarInitial("(bot) 42")).toBe("B");
    expect(avatarInitial("omega")).toBe("O");
    expect(avatarInitial("---")).toBe("?");
  });

  it("gives the same author the same hue", () => {
    expect(avatarHue("Ada")).toBe(avatarHue("Ada"));
    expect(avatarHue("Ada")).toBeGreaterThanOrEqual(0);
    expect(avatarHue("Ada")).toBeLessThan(360);
  });

  it("picks a stable color", () => {
    expect(avatarColor("Ada")).toBe(avatarColor("Ada"));
    expect(avatarColor("Ada")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
