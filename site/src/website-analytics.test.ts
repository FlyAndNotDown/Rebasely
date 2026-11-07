import { describe, expect, it, vi } from "vitest";
import { createGoogleTag } from "./google-tag";
import { createWebsiteAnalytics, installerDownloadParameters, websiteAnalyticsLocale } from "./website-analytics";

const ORIGIN = "https://rebaseraven.flyandnotdown.com";
const WINDOWS = "https://github.com/FlyAndNotDown/RebaseRaven/releases/download/v1.2.3/RebaseRaven_v1.2.3_windows_x64.exe";
const MACOS = "https://github.com/FlyAndNotDown/RebaseRaven/releases/download/v1.2.3/RebaseRaven_v1.2.3_macos_arm64.dmg";

function fixture(pathname = "/en/", origin = ORIGIN) {
  const script = { onload: null as (() => void) | null, onerror: null as (() => void) | null, src: "", remove: vi.fn() };
  const host = {
    location: { origin, pathname },
    document: { createElement: vi.fn(() => script), head: { appendChild: vi.fn() } },
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), parent: null as unknown,
  };
  host.parent = host;
  return { host: host as unknown as Window, script, globals: host as unknown as Record<string, unknown> };
}

describe("website analytics isolation", () => {
  it("counts locale pages while excluding redirects, the desktop bridge and preview origins", () => {
    for (const [path, locale] of [["/en/", "en"], ["/zh-CN/", "zh-CN"], ["/en/index.html", "en"]]) {
      expect(websiteAnalyticsLocale({ origin: ORIGIN, pathname: path })).toBe(locale);
    }
    for (const path of ["/", "/analytics/", "/analytics/en/", "/en/private", "/unsupported/"]) {
      const { host } = fixture(path);
      expect(createWebsiteAnalytics(host, "G-WEBSITE42")).toBeNull();
      expect(host.document.createElement).not.toHaveBeenCalled();
    }
    const { host } = fixture("/en/", "https://example.com");
    expect(createWebsiteAnalytics(host, "G-WEBSITE42")).toBeNull();
    expect(host.document.createElement).not.toHaveBeenCalled();
  });

  it("uses an independent web identity and leaves page views, referrers and acquisition to the web tag", () => {
    const { host, script, globals } = fixture("/zh-CN/");
    const analytics = createWebsiteAnalytics(host, "G-WEBSITE42");
    script.onload?.();
    expect(analytics).not.toBeNull();
    const commands = (globals.dataLayer as IArguments[]).map((args) => Array.from(args));
    expect(commands[2]).toEqual(["config", "G-WEBSITE42", {
      send_page_view: true, content_group: "Website", site_language: "zh-CN",
      cookie_prefix: "rebaseraven_website", cookie_domain: "none",
      allow_google_signals: false, allow_ad_personalization_signals: false,
    }]);
    for (const name of ["client_id", "session_id", "app_name", "app_version", "page_referrer", "ignore_referrer"]) {
      expect(commands[2][2]).not.toHaveProperty(name);
    }
    expect(script.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-WEBSITE42");
  });

  it("routes download intent, installer clicks and demo usage exclusively to the website property", () => {
    const { host, script, globals } = fixture();
    const analytics = createWebsiteAnalytics(host, "G-WEBSITE42")!;
    script.onload?.();
    analytics.downloadDialog("hero");
    analytics.installerDownload("windows", WINDOWS, "v1.2.3");
    analytics.installerDownload("macos", MACOS, "v1.2.3");
    analytics.installerDownload("windows", "https://github.com/FlyAndNotDown/RebaseRaven/releases/latest", "v1.2.3");
    analytics.demoStart();
    const commands = (globals.dataLayer as IArguments[]).slice(3).map((args) => Array.from(args));
    expect(commands.map((command) => command[1])).toEqual(["download_dialog_open", "file_download", "file_download", "demo_start"]);
    expect(commands[0][2]).toMatchObject({ entry_point: "hero", site_language: "en" });
    expect(commands[1][2]).toMatchObject({ download_platform: "windows", file_extension: "exe", release_version: "v1.2.3" });
    expect(commands[2][2]).toMatchObject({ download_platform: "macos", file_extension: "dmg" });
    expect(commands.every((command) => (command[2] as Record<string, unknown>).send_to === "G-WEBSITE42")).toBe(true);
  });

  it("does not initialize inside another page, with missing configuration or after a blocked tag", async () => {
    const embedded = fixture();
    Object.assign(embedded.host, { parent: {} });
    expect(createWebsiteAnalytics(embedded.host, "G-WEBSITE42")).toBeNull();
    expect(embedded.host.document.createElement).not.toHaveBeenCalled();
    const { host, script, globals } = fixture();
    expect(createWebsiteAnalytics(host, undefined)).toBeNull();
    const analytics = createWebsiteAnalytics(host, "G-WEBSITE42")!;
    script.onerror?.();
    await Promise.resolve();
    analytics.demoStart();
    expect(globals["ga-disable-G-WEBSITE42"]).toBe(true);
    expect(globals.dataLayer).toEqual([]);
    expect(script.remove).toHaveBeenCalledOnce();
  });
});

describe("download and tag routing boundaries", () => {
  it("rejects fallback links, other products, mismatched platforms and arbitrary URL fields", () => {
    expect(installerDownloadParameters("windows", WINDOWS, "v1.2.3")).not.toBeNull();
    for (const url of [MACOS, WINDOWS + "?private=value", WINDOWS + "#extra", WINDOWS.replace("RebaseRaven/releases", "OtherProduct/releases")]) {
      expect(installerDownloadParameters("windows", url, "v1.2.3")).toBeNull();
    }
    expect(installerDownloadParameters("windows", WINDOWS, "invalid")).toBeNull();
    expect(installerDownloadParameters("windows", WINDOWS, "v1.2.4")).toBeNull();
  });

  it("cannot override the configured property using event parameters", async () => {
    const { host, script, globals } = fixture();
    const tag = createGoogleTag(host, "G-WEBSITE42", { send_page_view: true });
    script.onload?.();
    await tag.ready;
    tag.send("demo_start", { send_to: "G-OTHER123" });
    const command = Array.from((globals.dataLayer as IArguments[])[3]);
    expect(command[2]).toEqual({ send_to: "G-WEBSITE42" });
    tag.disable();
  });
});
