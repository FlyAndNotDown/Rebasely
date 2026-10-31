import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("button form semantics", () => {
  it("does not submit a surrounding form unless explicitly requested", () => {
    expect(renderToStaticMarkup(createElement(Button, null, "Cancel"))).toContain('type="button"');
    expect(renderToStaticMarkup(createElement(Button, { type: "submit" }, "Save"))).toContain('type="submit"');
  });

  it("does not add button-only attributes to a slotted link", () => {
    const html = renderToStaticMarkup(createElement(Button, { asChild: true }, createElement("a", { href: "#details" }, "Details")));
    expect(html).toContain('href="#details"');
    expect(html).not.toContain('type="button"');
  });
});
