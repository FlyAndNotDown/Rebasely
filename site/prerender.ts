import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import { SITE_URL, softwareApplication } from "./src/product.ts";
import { localeFromPath, SITE_LOCALES, siteResources, type SiteLocale } from "./src/i18n.ts";

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function metadata(locale: SiteLocale, rootPage: boolean) {
  const copy = siteResources[locale];
  const url = rootPage ? SITE_URL : `${SITE_URL}${locale}/`;
  const title = escapeAttribute(copy["meta.title"]);
  const description = escapeAttribute(copy["meta.description"]);
  return `<!--site-meta-start-->
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Rebasely">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${SITE_URL}assets/social.png">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Rebasely — Git + Perforce">
    <meta property="og:url" content="${url}">
    <meta property="og:locale" content="${locale === "en" ? "en_US" : "zh_CN"}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${SITE_URL}assets/social.png">
    <link rel="canonical" href="${url}">
    ${SITE_LOCALES.map((language) => `<link rel="alternate" hreflang="${language}" href="${SITE_URL}${language}/">`).join("\n    ")}
    <link rel="alternate" hreflang="x-default" href="${SITE_URL}">
    <script type="application/ld+json">${JSON.stringify(softwareApplication(locale, rootPage)).replace(/</g, "\\u003c")}</script>
    <!--site-meta-end-->`;
}

export function productMetadata(): Plugin {
  return {
    name: "rebasely-product-metadata",
    transformIndexHtml(html, context) {
      const locale = localeFromPath(context.path);
      return html.replace("<!--site-metadata-->", metadata(locale ?? "en", locale === null))
        .replace('<html lang="en"', `<html lang="${locale ?? "en"}"`);
    },
  };
}

export function prerender(root: string): Plugin {
  let outputDirectory: string;
  return {
    name: "rebasely-prerender",
    apply: "build",
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const server = await createServer({
        configFile: path.join(root, "vite.config.ts"),
        server: { middlewareMode: true, hmr: false },
        appType: "custom",
      });
      try {
        const { render } = await server.ssrLoadModule("/src/entry-server.tsx") as { render: (locale: SiteLocale, rootPage: boolean) => Promise<string> };
        const filename = path.join(outputDirectory, "index.html");
        const template = await readFile(filename, "utf8");
        const placeholder = '<div id="root"></div>';
        if (!template.includes(placeholder)) throw new Error("Website template is missing its hydration root.");
        for (const route of [null, ...SITE_LOCALES]) {
          const locale = route ?? "en";
          const content = await render(locale, route === null);
          if (!content.includes("<main")) throw new Error(`Website prerender failed for ${locale}.`);
          const localized = template
            .replace(/<!--site-meta-start-->[\s\S]*?<!--site-meta-end-->/, () => metadata(locale, route === null))
            .replace('<html lang="en"', `<html lang="${locale}"`)
            .replace(placeholder, () => `<div id="root" data-prerendered="true">${content}</div>`);
          const directory = route ? path.join(outputDirectory, route) : outputDirectory;
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "index.html"), route ? localized.replace(/((?:src|href)=")\.\/assets\//g, "$1../assets/") : localized);
        }
      } finally {
        await server.close();
      }
    },
  };
}
