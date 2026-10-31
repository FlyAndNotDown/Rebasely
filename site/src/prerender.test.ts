import { describe, expect, it } from "vitest";
import { render } from "./entry-server";
import { LATEST_RELEASE_URL } from "./release-downloads";
import { siteResources } from "./i18n";

describe("website prerender", () => {
  it("renders product facts and working download URLs without a browser", async () => {
    const html = await render();
    expect(html).toContain('<main id="main"');
    expect(html).toContain(siteResources.en["hero.title"].split("\n")[0]);
    expect(html).toContain("macOS Apple Silicon");
    expect(html).toContain("Windows x64");
    expect(html).toContain("Git and Perforce");
    expect(html).toContain("open source under the MIT License.");
    expect(html.split(`href="${LATEST_RELEASE_URL}"`)).toHaveLength(4);
    expect(html).toContain("Enable JavaScript to try the interactive demo.");
    expect(html).toContain('id="demo-commit-message"');
    expect(html).not.toContain('id="demo-changelist-description"');
    expect(html).not.toContain(siteResources.en["demo.loadingPerforce"]);
    expect(html).not.toMatch(/<script\b/i);
  });

  it("prerenders complete Chinese copy and locale links without leaking locale state", async () => {
    const translated = await render("zh-CN", false);
    expect(translated).toContain(siteResources["zh-CN"]["preview.title"]);
    expect(translated).toContain(siteResources["zh-CN"]["demo.gitIntro"]);
    expect(translated).toContain('href="../en/"');
    expect(translated).toContain('href="../zh-CN/"');
    const english = await render("en", false);
    expect(english).toContain(siteResources.en["preview.title"]);
    expect(english).not.toContain(siteResources["zh-CN"]["preview.title"]);
  });

  it("keeps the initial platform and generated accessibility IDs deterministic", async () => {
    const first = await render();
    const second = await render();
    expect(first).toContain('data-platform="macos"');
    expect(first).toContain("rebasely-");
    expect(second).toBe(first);
  });
});
