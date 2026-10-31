import { createInstance } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };

export const SITE_LOCALES = ["en", "zh-CN"] as const;
export type SiteLocale = typeof SITE_LOCALES[number];
export const LANGUAGE_STORAGE_KEY = "rebasely.site.language";
export const siteResources = { en, "zh-CN": zhCN };

export function isSiteLocale(value: unknown): value is SiteLocale {
  return SITE_LOCALES.some((locale) => locale === value);
}

export function browserLocale(languages: readonly string[]): SiteLocale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}

export function localeFromPath(pathname: string): SiteLocale | null {
  const last = pathname.replace(/\/index\.html$/, "/").replace(/\/+$/, "").split("/").at(-1);
  return isSiteLocale(last) ? last : null;
}

export function localeHref(locale: SiteLocale, rootPage: boolean) {
  return `${rootPage ? "./" : "../"}${locale}/`;
}

export function rememberSiteLanguage(locale: SiteLocale | null) {
  try {
    if (locale) localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
    else localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Explicit language links continue to work without browser storage.
  }
}

export function preferredSiteLocale(languages: readonly string[]): SiteLocale {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isSiteLocale(saved)) return saved;
  } catch {
    // Browser language remains available when storage is unavailable.
  }
  return browserLocale(languages);
}

export function createSiteI18n(locale: SiteLocale) {
  const instance = createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: "en",
    supportedLngs: [...SITE_LOCALES],
    resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
    initAsync: false,
    keySeparator: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}
