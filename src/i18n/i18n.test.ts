import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatBytes, formatDate, formatNumber, i18n, normalizeLanguage, resolveLanguage, setLanguagePreference, t, useTranslation } from "./index";
import { normalizePrefs } from "@/lib/prefs";

afterEach(() => {
  setLanguagePreference("en");
  vi.unstubAllGlobals();
});

describe("application language", () => {
  it("follows the first supported device language and falls back to English", () => {
    expect(resolveLanguage("system", ["fr-FR", "zh-TW", "en-US"])).toBe("zh-CN");
    expect(resolveLanguage("system", ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveLanguage("system", ["de-DE"])).toBe("en");
    expect(resolveLanguage("en", ["zh-CN"])).toBe("en");
    expect(resolveLanguage("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("reads older preferences and rejects unsupported saved choices", () => {
    expect(normalizePrefs({}).language).toBe("system");
    expect(normalizePrefs({ language: "zh-CN" }).language).toBe("zh-CN");
    expect(normalizeLanguage("fr-FR")).toBe("system");
    expect(normalizeLanguage(null)).toBe("system");
  });

  it("updates the document language and React resources without changing entered data", () => {
    const document = { documentElement: { lang: "" } };
    vi.stubGlobal("document", document);
    function Label() {
      const { t } = useTranslation();
      return createElement("button", { "aria-label": t("common.closeNamed", { name: "feature/<sample>" }) }, t("common.settings"));
    }
    setLanguagePreference("en");
    const english = renderToStaticMarkup(createElement(Label));
    setLanguagePreference("zh-CN");
    const chinese = renderToStaticMarkup(createElement(Label));
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(chinese).not.toBe(english);
    expect(chinese).toContain("feature/&lt;sample&gt;");
    expect(t("common.settings")).toBe(i18n.getResource("zh-CN", "translation", "common.settings"));
  });

  it("uses interpolation, plural rules, and the selected locale for dates and numbers", () => {
    setLanguagePreference("en");
    expect(t("common.everyMinutes", { count: 1 })).toBe("Every 1 minute");
    expect(t("common.everyMinutes", { count: 5 })).toBe("Every 5 minutes");
    expect(t("common.closeNamed", { name: "topic/42" })).toBe("Close topic/42");
    const date = new Date(2026, 9, 31, 12, 30);
    const englishDate = formatDate(date, { year: "numeric", month: "long", day: "numeric" });
    expect(englishDate).toContain("October");
    setLanguagePreference("zh-CN");
    expect(formatDate(date, { year: "numeric", month: "long", day: "numeric" })).not.toBe(englishDate);
    expect(formatNumber(12345.5)).toBe("12,345.5");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(t("common.everyMinutes", { count: 5 })).not.toContain("minute");
    expect(t("common.closeNamed", { name: "topic/42" })).toContain("topic/42");
  });
});
