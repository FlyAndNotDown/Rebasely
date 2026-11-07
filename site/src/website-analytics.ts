import { createGoogleTag } from "./google-tag";
import { SITE_URL } from "./product";
import { REPOSITORY_URL } from "./release-downloads";

export type DownloadEntryPoint = "header" | "hero" | "footer";
export type DownloadPlatform = "macos" | "windows";

export function websiteAnalyticsLocale(location: Pick<Location, "origin" | "pathname">) {
  if (location.origin !== new URL(SITE_URL).origin) return null;
  return /^\/(en|zh-CN)\/(?:index\.html)?$/.exec(location.pathname)?.[1] ?? null;
}

export function installerDownloadParameters(platform: DownloadPlatform, url: string, version: string) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) return null;
  const names = platform === "macos"
    ? [`RebaseRaven_${version}_macos_arm64.dmg`]
    : [`RebaseRaven_${version}_windows_x64.exe`, `RebaseRaven_${version}_windows_x64.msi`];
  const name = names.find((name) => url === `${REPOSITORY_URL}/releases/download/${version}/${name}`);
  if (!name) return null;
  return {
    file_name: name,
    file_extension: name.split(".").at(-1),
    link_url: url,
    download_platform: platform,
    release_version: version,
  };
}

export function createWebsiteAnalytics(host: Window, measurementId: string | undefined) {
  const locale = websiteAnalyticsLocale(host.location);
  // Count only public locale pages. Redirects, previews and the desktop bridge
  // must never create website visits or share the app's installation identity.
  if (!locale || host.parent !== host) return null;
  let tag;
  try {
    tag = createGoogleTag(host, measurementId, {
      send_page_view: true,
      content_group: "Website",
      site_language: locale,
      cookie_prefix: "rebaseraven_website",
      cookie_domain: "none",
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  } catch {
    return null;
  }
  void tag.ready.catch(() => tag.disable());
  return {
    downloadDialog(entryPoint: DownloadEntryPoint) {
      tag.send("download_dialog_open", { entry_point: entryPoint, site_language: locale });
    },
    installerDownload(platform: DownloadPlatform, url: string, version: string) {
      const parameters = installerDownloadParameters(platform, url, version);
      if (parameters) tag.send("file_download", { ...parameters, site_language: locale });
    },
    demoStart() {
      tag.send("demo_start", { site_language: locale });
    },
  };
}

let websiteAnalytics: ReturnType<typeof createWebsiteAnalytics> = null;

export function initializeWebsiteAnalytics(host: Window, measurementId: string | undefined) {
  websiteAnalytics ??= createWebsiteAnalytics(host, measurementId);
}

export const trackDownloadDialog = (entryPoint: DownloadEntryPoint) => websiteAnalytics?.downloadDialog(entryPoint);
export const trackInstallerDownload = (platform: DownloadPlatform, url: string, version: string) => websiteAnalytics?.installerDownload(platform, url, version);
export const trackDemoStart = () => websiteAnalytics?.demoStart();
