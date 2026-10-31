import { describe, expect, it } from "vitest";
import { browserLocale, createSiteI18n, localeFromPath, localeHref, siteResources } from "./i18n";

describe("website localization", () => {
  it("selects the first supported browser language and falls back to English", () => {
    expect(browserLocale(["fr-FR", "zh-Hans"])).toBe("zh-CN");
    expect(browserLocale(["en-GB", "zh-CN"])).toBe("en");
    expect(browserLocale(["de-DE"])).toBe("en");
    expect(browserLocale([])).toBe("en");
  });

  it("keeps explicit language routes independent of the hosting prefix", () => {
    expect(localeFromPath("/Rebasely/zh-CN/")).toBe("zh-CN");
    expect(localeFromPath("/en/index.html")).toBe("en");
    expect(localeFromPath("/Rebasely/")).toBeNull();
    expect(localeHref("en", false)).toBe("../en/");
    expect(localeHref("zh-CN", true)).toBe("./zh-CN/");
  });

  it("keeps resource keys and interpolation contracts aligned", () => {
    expect(Object.keys(siteResources["zh-CN"]).sort()).toEqual(Object.keys(siteResources.en).sort());
    for (const [key, value] of Object.entries(siteResources.en)) {
      const translated = siteResources["zh-CN"][key as keyof typeof siteResources.en];
      expect([...translated.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort()).toEqual([...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort());
    }
    expect(createSiteI18n("zh-CN").t("demo.changedFiles", { count: 3 })).not.toContain("{{");
  });
});
