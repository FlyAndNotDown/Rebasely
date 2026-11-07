import { pathToFileURL } from "node:url";

class SubmissionError extends Error {}

function websiteUrl(value, asDirectory = true) {
  let site;
  try { site = new URL(value); } catch { throw new SubmissionError("A valid website URL is required."); }
  if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash) {
    throw new SubmissionError("The website URL must use HTTPS without credentials, a query, or a fragment.");
  }
  if (asDirectory && !site.pathname.endsWith("/")) site.pathname += "/";
  return site;
}

function propertyForSite(site, property) {
  if (property === undefined || property === "") return site.href;
  if (typeof property !== "string" || /[\s\p{Cc}]/u.test(property)) {
    throw new SubmissionError("A valid Search Console property is required.");
  }
  if (property.startsWith("sc-domain:")) {
    const domain = property.slice("sc-domain:".length).toLowerCase();
    const labels = domain.split(".");
    if (domain.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1)) ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new SubmissionError("A valid Search Console domain property is required.");
    }
    if (site.hostname !== domain && !site.hostname.endsWith(`.${domain}`)) {
      throw new SubmissionError("The deployed website is outside the Search Console domain property.");
    }
    return `sc-domain:${domain}`;
  }
  const prefix = websiteUrl(property, false);
  const directoryPrefix = prefix.href.endsWith("/") ? prefix.href : `${prefix.href}/`;
  if (prefix.origin !== site.origin || !site.href.startsWith(directoryPrefix)) {
    throw new SubmissionError("The deployed website is outside the Search Console URL-prefix property.");
  }
  return prefix.href;
}

export function sitemapSubmission(siteUrl, searchConsoleProperty) {
  const site = websiteUrl(siteUrl);
  const property = propertyForSite(site, searchConsoleProperty);
  const sitemap = new URL("sitemap.xml", site);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemap.href)}`;
  return { site: site.href, sitemap: sitemap.href, endpoint };
}

async function readBoundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new SubmissionError("The published sitemap is empty.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new SubmissionError("The published sitemap exceeds the submission limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function submitSitemap({ siteUrl, searchConsoleProperty, accessToken, fetcher = fetch }) {
  const submission = sitemapSubmission(siteUrl, searchConsoleProperty);
  if (typeof accessToken !== "string" || !/^[a-zA-Z0-9._~+/=-]{20,8192}$/.test(accessToken)) {
    throw new SubmissionError("A Google access token is required.");
  }
  const published = await fetcher(submission.sitemap, {
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (published.status !== 200) throw new SubmissionError(`Published sitemap returned HTTP ${published.status}.`);
  const xml = await readBoundedText(published);
  const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
  const withinSite = (location) => {
    try {
      const url = new URL(location);
      return url.href.startsWith(submission.site) && !url.username && !url.password && !url.hash;
    } catch { return false; }
  };
  if (!/<urlset[\s>]/.test(xml) || !locations.includes(submission.site) || locations.some((url) => !withinSite(url))) {
    throw new SubmissionError("The published sitemap must contain the deployed homepage and stay within the website.");
  }
  const response = await fetcher(submission.endpoint, {
    method: "PUT", headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new SubmissionError(`Search Console submission returned HTTP ${response.status}.`);
  return submission;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await submitSitemap({ siteUrl: process.env.SITE_URL, searchConsoleProperty: process.env.SEARCH_CONSOLE_PROPERTY, accessToken: process.env.GOOGLE_ACCESS_TOKEN });
    console.log("Submitted the deployed sitemap to Google Search Console.");
  } catch (error) {
    console.error(error instanceof SubmissionError ? error.message : "Sitemap submission failed. Check the published sitemap, repository secrets, and Search Console permissions.");
    process.exitCode = 1;
  }
}
