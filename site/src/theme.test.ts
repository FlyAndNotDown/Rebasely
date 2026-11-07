import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, subscribe } from "./theme";

describe("website browser theme color", () => {
  const systemTheme = Object.assign(new EventTarget(), { matches: false });
  const browser = Object.assign(new EventTarget(), { matchMedia: () => systemTheme });
  const root = { dataset: { siteTheme: "dark" }, style: { colorScheme: "dark" }, classList: { toggle: vi.fn() } };
  const attributes = new Map<string, string>();
  const themeColor = { setAttribute: (name: string, value: string) => attributes.set(name, value) };
  let unsubscribe: (() => void) | undefined;
  let hasThemeColor = true;

  beforeEach(() => {
    systemTheme.matches = false;
    root.dataset.siteTheme = "dark";
    root.style.colorScheme = "dark";
    root.classList.toggle.mockClear();
    attributes.clear();
    hasThemeColor = true;
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", { documentElement: root, querySelector: () => hasThemeColor ? themeColor : null });
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    vi.unstubAllGlobals();
  });

  function storage(key: string | null, newValue: string | null) {
    browser.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
  }

  it("keeps the browser chrome and page scheme aligned for explicit themes", () => {
    applyTheme("light");
    expect(attributes.get("content")).toBe("#fafafa");
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.siteTheme).toBe("light");
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", false);

    applyTheme("dark");
    expect(attributes.get("content")).toBe("#0a0a0a");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.dataset.siteTheme).toBe("dark");
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);
  });

  it("initializes from the theme selected before hydration", () => {
    root.dataset.siteTheme = "light";
    unsubscribe = subscribe(vi.fn());
    expect(attributes.get("content")).toBe("#fafafa");
    expect(root.dataset.siteTheme).toBe("light");
  });

  it("follows operating system changes only while system is selected", () => {
    applyTheme("system");
    unsubscribe = subscribe(vi.fn());
    expect(attributes.get("content")).toBe("#fafafa");

    systemTheme.matches = true;
    systemTheme.dispatchEvent(new Event("change"));
    expect(attributes.get("content")).toBe("#0a0a0a");
    expect(root.dataset.siteTheme).toBe("system");

    applyTheme("light");
    systemTheme.dispatchEvent(new Event("change"));
    expect(attributes.get("content")).toBe("#fafafa");
    expect(root.dataset.siteTheme).toBe("light");
  });

  it("tracks another tab's selection and returns to the default when storage is cleared", () => {
    const onChange = vi.fn();
    unsubscribe = subscribe(onChange);
    storage("unrelated-setting", "light");
    expect(attributes.get("content")).toBe("#0a0a0a");
    expect(onChange).not.toHaveBeenCalled();

    storage("rebaseraven-site-theme", "light");
    expect(attributes.get("content")).toBe("#fafafa");
    expect(root.dataset.siteTheme).toBe("light");
    expect(onChange).toHaveBeenCalledOnce();

    systemTheme.matches = true;
    storage("rebaseraven-site-theme", "system");
    expect(attributes.get("content")).toBe("#0a0a0a");
    expect(root.dataset.siteTheme).toBe("system");

    systemTheme.matches = false;
    storage(null, null);
    expect(attributes.get("content")).toBe("#0a0a0a");
    expect(root.dataset.siteTheme).toBe("dark");
  });

  it("releases system and storage listeners when the subscriber unmounts", () => {
    applyTheme("system");
    const stop = subscribe(vi.fn());
    stop();
    systemTheme.matches = true;
    systemTheme.dispatchEvent(new Event("change"));
    storage("rebaseraven-site-theme", "dark");
    expect(attributes.get("content")).toBe("#fafafa");
    expect(root.dataset.siteTheme).toBe("system");
  });

  it("keeps theme selection usable when the optional metadata element is absent", () => {
    hasThemeColor = false;
    expect(() => applyTheme("light")).not.toThrow();
    expect(root.style.colorScheme).toBe("light");
  });
});
