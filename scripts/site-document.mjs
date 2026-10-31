const REPOSITORY_URL = "https://github.com/FlyAndNotDown/Rebasely";
const DOWNLOAD_URL = `${REPOSITORY_URL}/releases/latest`;
const SUPPORTED_SYSTEMS = ["macOS (Apple Silicon)", "Windows (x64)"];
const SITE_URL = "https://flyandnotdown.github.io/Rebasely/";

function decodeText(value) {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|(amp|quot|apos|lt|gt|nbsp));/gi, (entity, numeric, named) => {
    if (numeric) {
      const code = numeric.toLowerCase().startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }[named.toLowerCase()];
  });
}

function attributes(source) {
  return new Map([...source.matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
    .map((match) => [match[1].toLowerCase(), decodeText(match[2] ?? match[3] ?? match[4] ?? "")]));
}

function elements(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>`, "gi"))]
    .map((match) => ({ attributes: attributes(match[1]), content: match[2] }));
}

function rootContent(html) {
  const opening = [...html.matchAll(/<div\b([^>]*)>/gi)].find((match) => attributes(match[1]).get("id") === "root");
  if (!opening || attributes(opening[1]).get("data-prerendered") !== "true") return "";
  const start = opening.index + opening[0].length;
  let depth = 1;
  for (const match of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/gi)) {
    depth += match[1] ? -1 : 1;
    if (!depth) return html.slice(start, start + match.index);
  }
  return "";
}

function readableText(html) {
  return decodeText(html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function validSiteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/");
  } catch { return false; }
}

export function validateSiteDocument({ html, sitemap, files, filename = "index.html" }) {
  const violations = [];
  const fail = (message) => violations.push(`${filename}: ${message}`);
  const content = rootContent(html);
  const mains = elements(content, "main");
  const headings = elements(content, "h1");
  const main = mains[0]?.content ?? "";
  if (mains.length !== 1 || headings.length !== 1 || !readableText(headings[0]?.content ?? "") || readableText(main).length < 200) {
    fail("prerendered root must contain one main, one readable h1, and product content without JavaScript");
  }

  const canonicals = [...html.matchAll(/<link\b([^>]*)>/gi)].map((match) => attributes(match[1]))
    .filter((attrs) => attrs.get("rel")?.toLowerCase().split(/\s+/).includes("canonical"));
  const canonical = canonicals[0]?.get("href");
  if (canonicals.length !== 1 || !validSiteUrl(canonical)) fail("provide exactly one HTTPS canonical project URL ending in a slash");
  const expectedCanonical = new URL(filename.replace(/index\.html$/, ""), SITE_URL).href;
  if (canonical !== expectedCanonical) fail("canonical must identify this language page within the public project");
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)].map((match) => attributes(match[1]));
  for (const [language, url] of [["en", `${SITE_URL}en/`], ["zh-CN", `${SITE_URL}zh-CN/`], ["x-default", SITE_URL]]) {
    const alternates = links.filter((attrs) => attrs.get("rel") === "alternate" && attrs.get("hreflang") === language);
    if (alternates.length !== 1 || alternates[0].get("href") !== url) fail(`provide one reciprocal ${language} language alternate`);
  }
  const ogUrls = [...html.matchAll(/<meta\b([^>]*)>/gi)].map((match) => attributes(match[1]))
    .filter((attrs) => attrs.get("property") === "og:url");
  if (ogUrls.length !== 1 || ogUrls[0].get("content") !== canonical) fail("og:url must match the unique canonical URL");

  const schemas = elements(html, "script").filter((entry) => entry.attributes.get("type")?.toLowerCase() === "application/ld+json");
  let product;
  try {
    if (schemas.length !== 1) throw new Error();
    product = JSON.parse(schemas[0].content);
  } catch { fail("provide one valid SoftwareApplication JSON-LD document"); }
  if (product) {
    if (product["@context"] !== "https://schema.org" || product["@type"] !== "SoftwareApplication" || product.name !== "Rebasely" ||
      product.url !== canonical || product.applicationCategory !== "DeveloperApplication" ||
      typeof product.description !== "string" || !product.description.trim() ||
      product.license !== "https://opensource.org/license/mit" || product.downloadUrl !== DOWNLOAD_URL || product.sameAs !== REPOSITORY_URL ||
      !Array.isArray(product.operatingSystem) || product.operatingSystem.length !== SUPPORTED_SYSTEMS.length ||
      !SUPPORTED_SYSTEMS.every((system) => product.operatingSystem.includes(system))) {
      fail("SoftwareApplication metadata must describe the public product, supported systems, MIT license, and stable release link");
    }
    const visible = readableText(main).toLowerCase();
    if (!visible.includes("macos") || !visible.includes("apple silicon") || !visible.includes("windows") || !visible.includes("x64") || !/\bmit\b/.test(visible)) {
      fail("supported systems and license must also be readable in the page content");
    }
  } else if (schemas.length === 1 && product !== undefined) fail("SoftwareApplication JSON-LD must be an object");

  if (!elements(main, "a").some((link) => link.attributes.get("href") === DOWNLOAD_URL && readableText(link.content) &&
    !link.attributes.has("hidden") && link.attributes.get("aria-hidden") !== "true")) {
    fail("main must include a readable release download link that works without JavaScript");
  }

  const locations = [...(sitemap ?? "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => decodeText(match[1]));
  if (!/<urlset[\s>]/.test(sitemap ?? "") || !canonical || locations.filter((url) => url === canonical).length !== 1 ||
    locations.some((value) => {
      try {
        const url = new URL(value);
        return !url.href.startsWith(SITE_URL) || Boolean(url.username || url.password || url.search || url.hash);
      } catch { return true; }
    })) violations.push("sitemap.xml: include the canonical homepage once and keep every URL within the canonical project");

  for (const filename of files) {
    if (/\.(?:tsx?|jsx|map)$/i.test(filename) || /(?:^|\/)(?:src|server|dist-ssr|node_modules|\.vite)(?:\/|$)/i.test(filename) ||
      /(?:^|\/)(?:entry-server|prerender|vite\.config|tsconfig)(?:[.-]|$)/i.test(filename) ||
      (/\.(?:mjs|cjs|js)$/i.test(filename) && !filename.startsWith("assets/"))) {
      violations.push(`${filename}: Pages output must not contain server bundles, source files, or source maps`);
    }
  }
  return violations;
}
