import { appendFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { parseReleaseDownloads } from "../site/src/release-downloads.ts";

const release = JSON.parse(await text(process.stdin));
const downloads = parseReleaseDownloads(release);
if (!downloads.macos || !downloads.windows) {
  throw new Error(`Release ${downloads.tag} is missing a website installer.`);
}
if (process.env.RELEASE_TAG && downloads.tag !== process.env.RELEASE_TAG) {
  throw new Error("GitHub returned a different release than the one being published.");
}

const snapshot = {
  tag_name: downloads.tag,
  draft: false,
  prerelease: false,
  assets: release.assets
    .filter((asset) => asset && [downloads.macos, downloads.windows].includes(asset.browser_download_url))
    .map(({ name, state, browser_download_url }) => ({ name, state, browser_download_url })),
};
appendFileSync(process.env.GITHUB_OUTPUT, `release=${JSON.stringify(snapshot)}\n`);
