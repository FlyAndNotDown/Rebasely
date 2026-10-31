import { describe, expect, it, vi } from "vitest";
import { sitemapSubmission, submitSitemap } from "./submit-sitemap.mjs";

const siteUrl = "https://example.com/client/";
const accessToken = "test-token-not-a-real-credential";
const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}</loc></url></urlset>`;

describe("Search Console sitemap submission", () => {
  it("encodes a project site and its sitemap as separate API path components", () => {
    expect(sitemapSubmission("https://example.com/client")).toEqual({
      site: siteUrl,
      sitemap: `${siteUrl}sitemap.xml`,
      endpoint: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(`${siteUrl}sitemap.xml`)}`,
    });
  });

  it.each(["http://example.com/", "https://alice:password@example.com/", "https://example.com/?token=private", "https://example.com/#section", "not a URL"])("rejects unsafe property URL %s", (url) => {
    expect(() => sitemapSubmission(url)).toThrow();
  });

  it("validates the published sitemap before sending a scoped token only to Google", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(xml)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await submitSitemap({ siteUrl, accessToken, fetcher });
    expect(fetcher.mock.calls[0][0]).toBe(`${siteUrl}sitemap.xml`);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers.Authorization");
    expect(fetcher.mock.calls[1][0]).toBe(sitemapSubmission(siteUrl).endpoint);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT", redirect: "error", headers: { Authorization: `Bearer ${accessToken}` } });
  });

  it.each([
    `<urlset><loc>https://elsewhere.example/</loc></urlset>`,
    xml.replace("</urlset>", "<url><loc>https://example.com/client/../private/</loc></url></urlset>"),
    `<html><loc>${siteUrl}</loc></html>`,
    "x".repeat(65 * 1024),
  ])("does not authenticate when the published sitemap is invalid", async (body) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(body));
    await expect(submitSitemap({ siteUrl, accessToken, fetcher })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports API failure without including its response body or token", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(xml)).mockResolvedValueOnce(new Response(`private response ${accessToken}`, { status: 403 }));
    await expect(submitSitemap({ siteUrl, accessToken, fetcher })).rejects.toThrow("Search Console submission returned HTTP 403.");
  });

  it("requires authorization before making any network request", async () => {
    const fetcher = vi.fn();
    await expect(submitSitemap({ siteUrl, accessToken: "", fetcher })).rejects.toThrow("A Google access token is required.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
