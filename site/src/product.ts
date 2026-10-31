import { LATEST_RELEASE_URL, REPOSITORY_URL } from "./release-downloads.ts";

export const SITE_URL = "https://flyandnotdown.github.io/Rebasely/";

export const SOFTWARE_APPLICATION = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Rebasely",
  url: SITE_URL,
  description: "A unified version control client for reviewing changes, following history, and working across repositories in one desktop workspace.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: ["macOS (Apple Silicon)", "Windows (x64)"],
  license: "https://opensource.org/license/mit",
  downloadUrl: LATEST_RELEASE_URL,
  sameAs: REPOSITORY_URL,
  featureList: [
    "Unified and split text diffs with image comparison",
    "Git staging by file, hunk, or line",
    "Git graphs and file history",
    "Perforce pending work, shelves, and submitted changelists",
    "Repository tabs, command palette, and light or dark themes",
  ],
} as const;
