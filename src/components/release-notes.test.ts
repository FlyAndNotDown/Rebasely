import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReleaseNotes } from "./release-notes";

function render(notes: string, onOpenLink = vi.fn()) {
  return renderToStaticMarkup(createElement(ReleaseNotes, { notes, label: "Release notes", onOpenLink }));
}

describe("release note Markdown", () => {
  it("renders headings, lists, emphasis, and code as semantic React elements", () => {
    const html = render("# Changes\n\n**Improved** *review*. Use `git status`.\n\n- First item\n- Second item\n\n```sh\ngit diff --stat\n```");
    expect(html).toContain("<h4");
    expect(html).toContain("<strong>Improved</strong>");
    expect(html).toContain("<em>review</em>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<code");
    expect(html).toContain("<pre");
    expect(html).toContain("git diff --stat");
    expect(html).not.toContain("<h1");
  });

  it("supports GFM tables, task lists, strikethrough, and automatic links", () => {
    const html = render("| Feature | Status |\n| --- | --- |\n| Review | Ready |\n\n- [x] Fixed\n- [ ] Follow-up\n\n~~Previous~~ https://example.com/docs");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Release notes"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("<del>Previous</del>");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("omits raw HTML and remote images without loading their resources", () => {
    const open = vi.fn();
    const html = render('<script>alert(1)</script>\n\n<iframe src="https://example.com/frame"></iframe>\n\n<img src="https://example.com/raw.png" onerror="alert(1)">\n\n![Preview](https://example.com/pixel.png)\n\n![Embedded](data:image/svg+xml,fixture)', open);
    expect(html).not.toMatch(/<(script|iframe|img)\b/);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("example.com");
    expect(html).not.toContain("data:image");
    expect(html).toContain("Preview");
    expect(html).toContain("Embedded");
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps unsafe link labels readable without an actionable href", () => {
    const html = render("[Unsafe](javascript:alert%281%29) [Credentials](https://alice:fixture-secret@example.com/) [File](file:///fixture.txt) [Safe](https://example.com/docs)");
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain("<span>Unsafe</span>");
    expect(html).toContain("<span>Credentials</span>");
    expect(html).toContain("<span>File</span>");
    expect(html).not.toContain("fixture-secret");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file:");
  });
});
