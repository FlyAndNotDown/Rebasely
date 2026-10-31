import type { AppPrefs } from "@/types/git";

export type HttpProxy = AppPrefs["httpProxy"];

export function normalizeHttpProxy(value: Partial<HttpProxy> | null | undefined): HttpProxy {
  const mode = value?.mode === "none" || value?.mode === "manual" ? value.mode : "system";
  return { mode, url: mode === "manual" && typeof value?.url === "string" ? value.url : "" };
}

export function proxyValidationError(proxy: HttpProxy): string | null {
  if (proxy.mode !== "manual") return null;
  const text = proxy.url.trim();
  if (text.length > 2048 || /\p{Cc}/u.test(text)) return "Enter a valid proxy URL.";
  let url: URL;
  try { url = new URL(text); }
  catch { return "Enter a proxy URL including its protocol."; }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || url.port === "0") {
    return "Use an HTTP, HTTPS, SOCKS5, or SOCKS5H proxy URL.";
  }
  if (url.username || url.password) return "Use a proxy URL without credentials.";
  if (url.search || url.hash || !["", "/"].includes(url.pathname)) return "Use only a protocol, host, and port.";
  return null;
}
