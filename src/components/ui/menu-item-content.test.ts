import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { describe, expect, it } from "vitest";
import { DropdownMenu, DropdownMenuItem, DropdownMenuShortcut } from "./dropdown-menu";
import { MenuItemContent, menuItemText } from "./menu-item-content";

const longRef = "feature/retain-complete-revision-names-in-menu-labels";

describe("menu item layout", () => {
  it("keeps full labels in the document while letting only the label shrink", () => {
    const icon = createElement("svg", { "aria-hidden": true });
    const shortcut = createElement(DropdownMenuShortcut, null, "⌘C");
    const html = renderToStaticMarkup(createElement(MenuItemContent, null, icon, longRef, shortcut));
    expect(html).toContain(`<span data-slot="menu-item-label" class="min-w-0 flex-1 truncate">${longRef}</span>`);
    expect(html).toContain("shrink-0 pl-4");
    expect(html).not.toContain('data-slot="menu-item-label"><svg');
    expect(menuItemText([icon, longRef])).toBe(longRef);
  });

  it("preserves selection icon gutters and intentionally stacked labels", () => {
    const indicator = createElement("span", { className: "min-w-4" });
    const label = createElement("span", { className: "flex flex-col" },
      createElement("span", null, "workspace"),
      createElement("span", null, "//depot/main"));
    const html = renderToStaticMarkup(createElement(MenuItemContent, null, indicator, label));
    expect(html).toContain('<span class="min-w-4"></span>');
    expect(html).toContain('class="flex flex-col min-w-0 truncate"');
    expect(menuItemText(label)).toBe("workspace //depot/main");
  });

  it("preserves the native link element and menu role for asChild callers", () => {
    const html = renderToStaticMarkup(createElement(DropdownMenu, { open: true },
      createElement(DropdownMenuPrimitive.Content, { forceMount: true },
        createElement(DropdownMenuItem, { asChild: true },
          createElement("a", { href: "/en/" }, "English")))));
    expect(html).toMatch(/<a[^>]*href="\/en\/"[^>]*role="menuitem"/);
    expect(html).toContain('title="English"');
    expect(html).toContain(">English</a>");
  });
});
