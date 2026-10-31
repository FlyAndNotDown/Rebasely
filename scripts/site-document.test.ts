import { describe, expect, it } from "vitest";
import { validateSiteDocument } from "./site-document.mjs";

const canonical = "https://flyandnotdown.github.io/Rebasely/";
const download = "https://github.com/FlyAndNotDown/Rebasely/releases/latest";
const product = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Rebasely",
  url: canonical,
  description: "A unified version control client.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: ["macOS (Apple Silicon)", "Windows (x64)"],
  license: "https://opensource.org/license/mit",
  downloadUrl: download,
  sameAs: "https://github.com/FlyAndNotDown/Rebasely",
};
const content = `<main><h1>A unified version control client</h1><p>${"Review changes and follow repository history. ".repeat(5)}</p><p>macOS Apple Silicon and Windows x64. MIT License.</p><a href="${download}"><svg><path /></svg>Download</a></main>`;

function fixture() {
  return {
    html: `<html><head><link href="${canonical}" rel="canonical"><meta content="${canonical}" property="og:url"><script type="application/ld+json">${JSON.stringify(product)}</script></head><body><div id="root" data-prerendered="true"><div>Rebasely</div>${content}</div></body></html>`,
    sitemap: `<urlset><url><loc>${canonical}</loc></url></urlset>`,
    files: new Set(["index.html", "sitemap.xml", "assets/index-abc.js", "assets/index-abc.css"]),
  };
}

describe("published website document", () => {
  it("accepts crawlable prerendered content with matching metadata and a real release link", () => {
    expect(validateSiteDocument(fixture())).toEqual([]);
  });

  it("rejects an empty hydration root even when product text exists elsewhere", () => {
    const value = fixture();
    value.html = value.html.replace(`<div id="root" data-prerendered="true"><div>Rebasely</div>${content}</div>`, `<div id="root" data-prerendered="true"></div>${content}`);
    expect(validateSiteDocument(value)).toContainEqual(expect.stringContaining("prerendered root"));
  });

  it("rejects duplicate or inconsistent canonical, Open Graph, and sitemap URLs", () => {
    const duplicate = fixture();
    duplicate.html = duplicate.html.replace("</head>", `<link rel="canonical" href="${canonical}"></head>`);
    expect(validateSiteDocument(duplicate)).toContainEqual(expect.stringContaining("exactly one HTTPS canonical"));
    const mismatch = fixture();
    mismatch.html = mismatch.html.replace(`content="${canonical}"`, 'content="https://site.example.com/"');
    mismatch.sitemap = "<urlset><url><loc>https://site.example.com/</loc></url></urlset>";
    expect(validateSiteDocument(mismatch)).toEqual(expect.arrayContaining([
      expect.stringContaining("og:url must match"), expect.stringContaining("sitemap.xml:"),
    ]));
  });

  it("rejects invalid JSON-LD and metadata that advertises an unsupported build", () => {
    const invalid = fixture();
    invalid.html = invalid.html.replace(JSON.stringify(product), "{");
    expect(validateSiteDocument(invalid)).toContainEqual(expect.stringContaining("valid SoftwareApplication"));
    const unsupported = fixture();
    unsupported.html = unsupported.html.replace(JSON.stringify(product), JSON.stringify({ ...product, operatingSystem: ["macOS (Intel)", "Windows (x64)"] }));
    expect(validateSiteDocument(unsupported)).toContainEqual(expect.stringContaining("supported systems"));
  });

  it("requires a download anchor in the main content instead of a JavaScript-only button", () => {
    const value = fixture();
    value.html = value.html.replace(`<a href="${download}"><svg><path /></svg>Download</a>`, "<button>Download</button>");
    expect(validateSiteDocument(value)).toContainEqual(expect.stringContaining("without JavaScript"));
  });

  it("rejects leaked SSR code and source maps while allowing the browser assets", () => {
    const value = fixture();
    for (const filename of ["src/entry-server.tsx", "entry-server.js", "assets/index.js.map", "assets/prerender.js", "dist-ssr/index.mjs"]) value.files.add(filename);
    const violations = validateSiteDocument(value);
    expect(violations).toHaveLength(5);
    expect(violations.every((message: string) => message.includes("Pages output must not contain"))).toBe(true);
  });
});
