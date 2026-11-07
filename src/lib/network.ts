import type { AppPrefs } from "@/types/git";
import { t } from "@/i18n";

export type HttpProxy = AppPrefs["httpProxy"];

export function normalizeHttpProxy(value: Partial<HttpProxy> | null | undefined): HttpProxy {
  const mode = value?.mode === "none" || value?.mode === "manual" ? value.mode : "system";
  return { mode, url: mode === "manual" && typeof value?.url === "string" ? value.url : "" };
}

export function proxyValidationError(proxy: HttpProxy): string | null {
  if (proxy.mode !== "manual") return null;
  const text = proxy.url.trim();
  if (text.length > 2048 || /\p{Cc}/u.test(text)) return t("validation.proxy.validUrl");
  let url: URL;
  try { url = new URL(text); }
  catch { return t("validation.proxy.protocol"); }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || url.port === "0") {
    return t("validation.proxy.supported");
  }
  if (url.username || url.password) return t("validation.proxy.credentials");
  if (url.search || url.hash || !["", "/"].includes(url.pathname)) return t("validation.proxy.addressOnly");
  return null;
}
