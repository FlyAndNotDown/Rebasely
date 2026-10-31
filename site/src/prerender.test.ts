import { describe, expect, it } from "vitest";
import { render } from "./entry-server";
import { LATEST_RELEASE_URL } from "./release-downloads";

describe("website prerender", () => {
  it("renders product facts and working download URLs without a browser", async () => {
    const html = await render();
    expect(html).toContain('<main id="main"');
    expect(html).toMatch(/<h1[^>]*>A unified<br\/>version control client\.<\/h1>/);
    expect(html).toContain("macOS Apple Silicon");
    expect(html).toContain("Windows x64");
    expect(html).toContain("Supports Git repositories and Perforce workspaces.");
    expect(html).toContain("Open source under the MIT License.");
    expect(html.split(`href="${LATEST_RELEASE_URL}"`)).toHaveLength(4);
    expect(html).toContain("Enable JavaScript to try the interactive demo.");
  });

  it("keeps the initial platform and generated accessibility IDs deterministic", async () => {
    const first = await render();
    const second = await render();
    expect(first).toContain('data-platform="macos"');
    expect(first).toContain("rebasely-");
    expect(second).toBe(first);
  });
});
