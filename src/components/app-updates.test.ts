import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdatesSettingsView } from "./app-updates";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { UpdateSnapshot } from "@/state/app-updates";

const available: UpdateSnapshot = {
  revision: 1, status: "available", request: null, lastRequest: "check", notice: null,
  update: { version: "0.1.6", currentVersion: "0.1.5", notes: "## Improvements\n\nReview changes.", publishedAt: null },
  downloadedBytes: 0, totalBytes: null, error: null,
};

function render(state: UpdateSnapshot) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(UpdatesSettingsView, { state, onCheck() {}, onInstall() {}, onRestart() {} })));
}

describe("update settings", () => {
  it("shows the available version and expanded release notes beside its update action", () => {
    const html = render(available);
    expect(html).toContain("v0.1.6</h4>");
    expect(html).toContain('aria-label="Release notes"');
    expect(html).not.toContain("<details");
    expect(html).toContain("Update</button>");
  });

  it("keeps release details while an installation is in progress and disables another install", () => {
    const html = render({ ...available, request: "install", lastRequest: "install" });
    expect(html).toContain("v0.1.6</h4>");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Update<\/button>/);
    expect(html).toContain('role="status"');
  });

  it("does not offer installation after success or invent a release when already current", () => {
    const installed = render({ ...available, status: "installed", lastRequest: "install" });
    expect(installed).not.toContain("Update</button>");
    expect(installed).toContain("Restart RebaseRaven</button>");
    const current = render({ ...available, status: "current", update: null });
    expect(current).not.toContain("v0.1.6");
    expect(current).not.toContain('aria-label="Release notes"');
  });
});
