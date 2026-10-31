import { createRoot, hydrateRoot } from "react-dom/client";
import { IDENTIFIER_PREFIX, SiteRoot } from "./app-root";
import { localeFromPath, localeHref, preferredSiteLocale } from "./i18n";
import "./styles.css";

const root = document.getElementById("root")!;
const pathLocale = localeFromPath(window.location.pathname);
const locale = pathLocale ?? "en";
const rootPage = pathLocale === null;
// Locale URLs are stable and never redirect based on browser preferences.
if (rootPage) {
  const preferred = preferredSiteLocale(navigator.languages);
  const target = new URL(localeHref(preferred, true), window.location.href);
  target.search = window.location.search;
  target.hash = window.location.hash;
  window.location.replace(target.href);
}
document.documentElement.lang = locale;
if (root.dataset.prerendered === "true") {
  hydrateRoot(root, <SiteRoot locale={locale} rootPage={rootPage} />, { identifierPrefix: IDENTIFIER_PREFIX });
} else {
  createRoot(root, { identifierPrefix: IDENTIFIER_PREFIX }).render(<SiteRoot locale={locale} rootPage={rootPage} />);
}
