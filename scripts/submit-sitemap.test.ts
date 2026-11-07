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
    expect(sitemapSubmission(siteUrl, "")).toEqual(sitemapSubmission(siteUrl));
  });

  it("submits a subdomain sitemap to its parent domain property", () => {
    const deployed = "https://client.example.com/";
    expect(sitemapSubmission(deployed, "sc-domain:example.com")).toEqual({
      site: deployed,
      sitemap: `${deployed}sitemap.xml`,
      endpoint: `https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/${encodeURIComponent(`${deployed}sitemap.xml`)}`,
    });
    expect(sitemapSubmission(siteUrl, "sc-domain:example.com").endpoint).toContain("/sites/sc-domain%3Aexample.com/");
  });

  it("keeps an explicitly selected URL-prefix property separate from the deployment path", () => {
    const deployed = "https://example.com/client/en/";
    const property = "https://example.com/client/";
    const submission = sitemapSubmission(deployed, property);
    expect(submission.site).toBe(deployed);
    expect(submission.sitemap).toBe(`${deployed}sitemap.xml`);
    expect(submission.endpoint).toContain(`/sites/${encodeURIComponent(property)}/`);
    expect(sitemapSubmission(deployed, "https://example.com").endpoint).toContain(`/sites/${encodeURIComponent("https://example.com/")}/`);
    expect(sitemapSubmission(deployed, "https://example.com/client").endpoint).toContain(`/sites/${encodeURIComponent("https://example.com/client")}/`);
  });

  it.each([
    ["https://notexample.com/", "sc-domain:example.com"],
    ["https://example.com.attacker.invalid/", "sc-domain:example.com"],
    [siteUrl, "sc-domain:elsewhere.example"],
    [siteUrl, "https://elsewhere.example/"],
    [siteUrl, "https://example.com/client/en/"],
    ["https://example.com/client-other/", "https://example.com/client/"],
    [siteUrl, "https://example.com:8443/"],
  ])("rejects a website outside its selected property", (deployed, property) => {
    expect(() => sitemapSubmission(deployed, property)).toThrow("outside the Search Console");
  });

  it.each([
    "sc-domain:", "sc-domain:example.com/", "sc-domain:example.com?private=value",
    "sc-domain:alice:password@example.com", "sc-domain:*.example.com", "sc-domain:example..com",
    "sc-domain:127.0.0.1", "sc-domain:-example.com", "sc-domain:example.com.",
    `sc-domain:${"a".repeat(64)}.com`, " sc-domain:example.com", "sc-domain:example.com\n",
    "https://alice:password@example.com/", "https://example.com/?private=value", "https://example.com/#fragment",
    "https://example.com/\u0000", "http://example.com/", "not a property",
  ])("rejects unsafe or malformed Search Console property IDs", (property) => {
    expect(() => sitemapSubmission(siteUrl, property)).toThrow();
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

  it("authenticates against the selected domain property without changing the public sitemap request", async () => {
    const searchConsoleProperty = "sc-domain:example.com";
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(xml)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await submitSitemap({ siteUrl, searchConsoleProperty, accessToken, fetcher });
    expect(fetcher.mock.calls[0][0]).toBe(`${siteUrl}sitemap.xml`);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(fetcher.mock.calls[1][0]).toBe(sitemapSubmission(siteUrl, searchConsoleProperty).endpoint);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT", redirect: "error", headers: { Authorization: `Bearer ${accessToken}` } });
  });

  it("rejects a mismatched property before fetching the sitemap or using a token", async () => {
    const fetcher = vi.fn();
    await expect(submitSitemap({ siteUrl, searchConsoleProperty: "sc-domain:elsewhere.example", accessToken, fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
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
