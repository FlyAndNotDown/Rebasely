# Search indexing

The Website workflow submits the published sitemap to Google Search Console after a successful deployment. Release calls the same workflow. Submission helps discovery; Google decides whether and when to crawl or index a page.

The ordinary website uses the [Search Console Sitemaps API](https://developers.google.com/webmaster-tools/v1/sitemaps/submit), not the Indexing API reserved for job postings and livestream pages. No scheduled polling or indexing requests run from the desktop app.

## One-time setup

1. Verify the website's URL-prefix property in Search Console. Keep the verification meta tag in `site/index.html`.
2. Enable the Search Console API in your Google Cloud project. Create a dedicated service account and grant it access to this one Search Console property.
3. Configure [Workload Identity Federation](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation) for GitHub Actions through that service account. Restrict the provider's condition to this repository, its owner, and the deployment refs you allow. Do not grant fork pull requests access. Follow the action's required IAM impersonation permissions; a project-wide administrator role is unnecessary.
4. Add `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` and `GOOGLE_SEARCH_CONSOLE_SERVICE_ACCOUNT` as repository secrets. The first is the provider resource name; the second is the dedicated service account address. Neither value belongs in tracked files.
5. Run Website from an allowed deployment branch. Confirm the `Submit sitemap` job succeeds and inspect the Sitemaps report in Search Console.

If neither secret is configured, the workflow reports that submission is not configured and skips authentication. A partial configuration fails with a clear error. Authentication uses a short-lived scoped token; no private key or credentials file is created, and the submission script never prints access tokens or API response bodies.

## Website changes

Keep the deployed URL, canonical URL, sitemap locations, verification tag, and Search Console property aligned when moving domains. Sitemap URLs must remain inside their property. The project site cannot publish the origin-level `robots.txt`, so discovery uses the explicitly submitted sitemap instead.

Source changes still go through `dev` and an explicitly authorized pull request before reaching `master`. A standalone Website deployment does not publish a desktop release or run Check.
