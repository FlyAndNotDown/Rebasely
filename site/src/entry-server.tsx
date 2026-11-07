import { prerenderToNodeStream } from "react-dom/static";
import { IDENTIFIER_PREFIX, SiteRoot } from "./app-root";
import type { SiteLocale } from "./i18n";

export async function render(locale: SiteLocale = "en", rootPage = true) {
  const errors: unknown[] = [];
  const { prelude } = await prerenderToNodeStream(<SiteRoot locale={locale} rootPage={rootPage} />, {
    identifierPrefix: IDENTIFIER_PREFIX,
    signal: AbortSignal.timeout(15_000),
    onError: (error) => { errors.push(error); },
  });
  let html = "";
  for await (const chunk of prelude) html += chunk.toString();
  if (errors.length) throw errors[0];
  return html;
}
