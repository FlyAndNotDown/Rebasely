import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { resolveLanguage, type LanguagePreference } from "./language";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import gitEn from "./locales/git.en.json";
import gitZhCN from "./locales/git.zh-CN.json";
import gitFilesEn from "./locales/git-files.en.json";
import gitFilesZhCN from "./locales/git-files.zh-CN.json";
import p4En from "./locales/p4.en.json";
import p4ZhCN from "./locales/p4.zh-CN.json";
import p4OperationsEn from "./locales/p4-operations.en.json";
import p4OperationsZhCN from "./locales/p4-operations.zh-CN.json";

export { useTranslation, Trans } from "react-i18next";
export { normalizeLanguage, resolveLanguage, type LanguagePreference } from "./language";

const resources = {
  en: { translation: { ...en, git: gitEn, "git-files": gitFilesEn, p4: p4En, "p4-operations": p4OperationsEn } },
  "zh-CN": { translation: { ...zhCN, git: gitZhCN, "git-files": gitFilesZhCN, p4: p4ZhCN, "p4-operations": p4OperationsZhCN } },
};

export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage("system"),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export const t = i18n.t.bind(i18n);
let languagePreference: LanguagePreference = "system";

export function setLanguagePreference(preference: LanguagePreference): void {
  languagePreference = preference;
  void i18n.changeLanguage(resolveLanguage(preference));
}

function updateDocumentLanguage(): void {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.resolvedLanguage ?? "en";
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();
if (typeof window !== "undefined") window.addEventListener("languagechange", () => setLanguagePreference(languagePreference));

export function currentLocale(): string {
  return i18n.resolvedLanguage ?? "en";
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value);
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(currentLocale(), options).format(value);
}

export function formatBytes(bytes: number): string {
  const divisor = bytes < 1024 ? 1 : bytes < 1_048_576 ? 1024 : 1_048_576;
  return t(divisor === 1 ? "units.bytes" : divisor === 1024 ? "units.kilobytes" : "units.megabytes", {
    value: formatNumber(bytes / divisor, { minimumFractionDigits: divisor === 1 ? 0 : 1, maximumFractionDigits: divisor === 1 ? 0 : 1 }),
  });
}
