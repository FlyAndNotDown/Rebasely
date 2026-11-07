import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createSiteI18n } from "./i18n";
import { GitDemo } from "./demo-git";
import { PerforceDemo } from "./demo-perforce";

function panelRoots(Demo: typeof GitDemo) {
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n: createSiteI18n("en") },
    createElement(TooltipProvider, null, createElement(Demo, { onNotice: () => {} }))));
  return [...html.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((match) => match[0]);
}

describe("demo view lifetime", () => {
  it("keeps Git views mounted so file choices and history filters survive switching", () => {
    const panels = panelRoots(GitDemo);
    expect(panels).toHaveLength(4);
    expect(panels.filter((panel) => !panel.includes('hidden=""'))).toHaveLength(1);
    expect(panels.filter((panel) => panel.includes('data-state="inactive"')).every((panel) => panel.includes('hidden=""'))).toBe(true);
  });

  it("keeps Perforce views mounted while hiding inactive workspaces", () => {
    const panels = panelRoots(PerforceDemo);
    expect(panels).toHaveLength(3);
    expect(panels.filter((panel) => !panel.includes('hidden=""'))).toHaveLength(1);
    expect(panels.filter((panel) => panel.includes('data-state="inactive"')).every((panel) => panel.includes('hidden=""'))).toBe(true);
  });
});
