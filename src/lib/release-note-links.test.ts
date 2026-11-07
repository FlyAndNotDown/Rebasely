import { describe, expect, it } from "vitest";
import { releaseNoteLink } from "./release-note-links";

describe("release note links", () => {
  it("allows web and email links for explicit native opening", () => {
    expect(releaseNoteLink("https://example.com/docs?a=1#changes")).toBe("https://example.com/docs?a=1#changes");
    expect(releaseNoteLink("http://example.com")).toBe("http://example.com/");
    expect(releaseNoteLink("mailto:alice@example.com")).toBe("mailto:alice@example.com");
  });

  it("resolves release-relative links to the public release page", () => {
    expect(releaseNoteLink("#changes")).toBe("https://github.com/FlyAndNotDown/RebaseRaven/releases/latest#changes");
    expect(releaseNoteLink("./tag/v1.2.3")).toBe("https://github.com/FlyAndNotDown/RebaseRaven/releases/tag/v1.2.3");
    expect(releaseNoteLink("//example.com/docs")).toBe("https://example.com/docs");
  });

  it("rejects executable protocols, controls, and embedded credentials", () => {
    for (const value of [
      "javascript:alert(1)", "data:text/html,fixture", "file:///fixture.txt", "ftp://example.com/",
      "https://alice:fixture-secret@example.com/", "https://alice@example.com/", "https://example.com/\nnext", "\thttps://example.com/",
    ]) expect(releaseNoteLink(value)).toBeUndefined();
  });

  it("rejects missing and oversized links before URL parsing", () => {
    expect(releaseNoteLink("")).toBeUndefined();
    expect(releaseNoteLink(`https://example.com/${"a".repeat(8192)}`)).toBeUndefined();
  });
});
