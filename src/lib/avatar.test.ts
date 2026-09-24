import { describe, expect, it } from "vitest";
import { avatarHue, avatarInitial, avatarSeed, normalizeAvatarProvider } from "./avatar";

describe("avatar", () => {
  it("defaults to local initials, including the value older builds always stored", () => {
    expect(normalizeAvatarProvider(undefined)).toBe("initials");
    expect(normalizeAvatarProvider("dicebear")).toBe("initials");
    expect(normalizeAvatarProvider("dicebear-online")).toBe("dicebear-online");
  });

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
});
