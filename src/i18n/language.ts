export const LANGUAGE_PREFERENCES = ["system", "en", "zh-CN"] as const;
export type LanguagePreference = typeof LANGUAGE_PREFERENCES[number];
export type SupportedLanguage = Exclude<LanguagePreference, "system">;

export function normalizeLanguage(value: unknown): LanguagePreference {
  return LANGUAGE_PREFERENCES.find((language) => language === value) ?? "system";
}

export function resolveLanguage(preference: LanguagePreference, languages: readonly string[] = systemLanguages()): SupportedLanguage {
  if (preference !== "system") return preference;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}

function systemLanguages(): readonly string[] {
  return typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
}
