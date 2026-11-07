import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScrollArea } from "@/components/ui/scroll-area";

function tags(html: string) {
  return {
    root: html.match(/<div\b[^>]*data-slot="scroll-area"[^>]*>/)?.[0],
    viewport: html.match(/<div\b[^>]*data-slot="scroll-area-viewport"[^>]*>/)?.[0],
  };
}

describe("demo keyboard scroll region", () => {
  it("places the keyboard stop and accessible name on the actual viewport", () => {
    const html = renderToStaticMarkup(createElement(ScrollArea, {
      viewportProps: { role: "region", "aria-label": "Sample diff", tabIndex: 0 },
    }, "Sample code"));
    const { root, viewport } = tags(html);
    expect(viewport).toContain('tabindex="0"');
    expect(viewport).toContain('role="region"');
    expect(viewport).toContain('aria-label="Sample diff"');
    expect(root).not.toContain("tabindex");
    expect(root).not.toContain("aria-label");
  });

  it("keeps existing callers unchanged when no viewport attributes are supplied", () => {
    const { viewport } = tags(renderToStaticMarkup(createElement(ScrollArea, null, "Sample code")));
    expect(viewport).toBeDefined();
    expect(viewport).not.toContain("tabindex");
    expect(viewport).not.toContain('role="region"');
  });
});
