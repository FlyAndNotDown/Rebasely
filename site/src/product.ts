import { LATEST_RELEASE_URL, REPOSITORY_URL } from "./release-downloads.ts";
import { siteResources, type SiteLocale } from "./i18n.ts";

export const SITE_URL = "https://flyandnotdown.github.io/Rebasely/";

export function softwareApplication(locale: SiteLocale = "en", rootPage = true) {
  const copy = siteResources[locale];
  return {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Rebasely",
  url: rootPage ? SITE_URL : `${SITE_URL}${locale}/`,
  description: copy["meta.description"],
  inLanguage: locale,
  applicationCategory: "DeveloperApplication",
  operatingSystem: ["macOS (Apple Silicon)", "Windows (x64)"],
  license: "https://opensource.org/license/mit",
  downloadUrl: LATEST_RELEASE_URL,
  sameAs: REPOSITORY_URL,
  featureList: [
    copy["features.review.body"],
    copy["features.history.body"],
    copy["features.context.body"],
  ],
  } as const;
}

export const SOFTWARE_APPLICATION = softwareApplication();
