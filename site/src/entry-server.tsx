import { prerenderToNodeStream } from "react-dom/static";
import { IDENTIFIER_PREFIX, SiteRoot } from "./app-root";

export async function render() {
  const errors: unknown[] = [];
  const { prelude } = await prerenderToNodeStream(<SiteRoot />, {
    identifierPrefix: IDENTIFIER_PREFIX,
    signal: AbortSignal.timeout(15_000),
    onError: (error) => { errors.push(error); },
  });
  let html = "";
  for await (const chunk of prelude) html += chunk.toString();
  if (errors.length) throw errors[0];
  return html;
}
