import { pathToFileURL } from "node:url";

class SubmissionError extends Error {}

export function sitemapSubmission(siteUrl) {
  let site;
  try { site = new URL(siteUrl); } catch { throw new SubmissionError("A valid website URL is required."); }
  if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash) {
    throw new SubmissionError("The website URL must use HTTPS without credentials, a query, or a fragment.");
  }
  if (!site.pathname.endsWith("/")) site.pathname += "/";
  const sitemap = new URL("sitemap.xml", site);
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.href)}/sitemaps/${encodeURIComponent(sitemap.href)}`;
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

export async function submitSitemap({ siteUrl, accessToken, fetcher = fetch }) {
  const submission = sitemapSubmission(siteUrl);
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
    await submitSitemap({ siteUrl: process.env.SITE_URL, accessToken: process.env.GOOGLE_ACCESS_TOKEN });
    console.log("Submitted the deployed sitemap to Google Search Console.");
  } catch (error) {
    console.error(error instanceof SubmissionError ? error.message : "Sitemap submission failed. Check the published sitemap, repository secrets, and Search Console permissions.");
    process.exitCode = 1;
  }
}
