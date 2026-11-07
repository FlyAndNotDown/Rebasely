import { describe, expect, it } from "vitest";
import { parseReleaseDownloads, readBundledReleaseDownloads, REPOSITORY_URL } from "./release-downloads";

function asset(name: string, tag = "v1.2.3") {
  return { name, state: "uploaded", browser_download_url: `${REPOSITORY_URL}/releases/download/${tag}/${name}` };
}

function release(assets: unknown[] = []) {
  return { tag_name: "v1.2.3", draft: false, prerelease: false, assets };
}

describe("website release downloads", () => {
  it("resolves matching platform installers from the returned version", () => {
    expect(parseReleaseDownloads(release([
      asset("RebaseRaven_v1.2.3_macos_arm64.dmg"),
      asset("RebaseRaven_v1.2.3_windows_x64.exe"),
      asset("RebaseRaven_v1.2.3_linux_x64.AppImage"),
      asset("RebaseRaven_v1.2.3_macos_x64.dmg"),
      asset("RebaseRaven_v1.2.3_macos_arm64.app.tar.gz"),
    ]))).toEqual({
      tag: "v1.2.3",
      macos: `${REPOSITORY_URL}/releases/download/v1.2.3/RebaseRaven_v1.2.3_macos_arm64.dmg`,
      windows: `${REPOSITORY_URL}/releases/download/v1.2.3/RebaseRaven_v1.2.3_windows_x64.exe`,
    });
  });

  it("prefers the Windows executable and can use an MSI installer", () => {
    const msi = asset("RebaseRaven_v1.2.3_windows_x64.msi");
    const exe = asset("RebaseRaven_v1.2.3_windows_x64.exe");
    expect(parseReleaseDownloads(release([msi, exe])).windows).toBe(exe.browser_download_url);
    expect(parseReleaseDownloads(release([msi])).windows).toBe(msi.browser_download_url);
  });

  it.each([
    "https://elsewhere.example/installer.dmg",
    "https://github.com/another/repository/releases/download/v1.2.3/RebaseRaven_v1.2.3_macos_arm64.dmg",
    `${REPOSITORY_URL}/releases/download/v9.9.9/RebaseRaven_v1.2.3_macos_arm64.dmg`,
    `${REPOSITORY_URL}/releases/download/v1.2.3/RebaseRaven_v1.2.3_macos_arm64.dmg?token=example`,
    "https://alice:example-password@github.com/FlyAndNotDown/RebaseRaven/releases/download/v1.2.3/RebaseRaven_v1.2.3_macos_arm64.dmg",
  ])("does not expose untrusted or mismatched download URL %s", (url) => {
    const installer = { ...asset("RebaseRaven_v1.2.3_macos_arm64.dmg"), browser_download_url: url };
    expect(parseReleaseDownloads(release([installer])).macos).toBeUndefined();
  });

  it("keeps missing or incomplete assets available for the latest-release fallback", () => {
    expect(parseReleaseDownloads(release())).toEqual({ tag: "v1.2.3" });
    expect(parseReleaseDownloads(release([{ ...asset("RebaseRaven_v1.2.3_macos_arm64.dmg"), state: "open" }])).macos).toBeUndefined();
  });

  it.each([null, {}, { ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), tag_name: "../other" }])("rejects invalid stable-release metadata", (value) => {
    expect(() => parseReleaseDownloads(value)).toThrow("Latest release information is unavailable.");
  });

  it("reads the installer snapshot embedded by the website build", () => {
    const filename = "RebaseRaven_v1.2.3_macos_arm64.dmg";
    expect(readBundledReleaseDownloads(JSON.stringify(release([asset(filename)])))).toEqual({
      tag: "v1.2.3",
      macos: `${REPOSITORY_URL}/releases/download/v1.2.3/${filename}`,
    });
  });

  it.each([undefined, "", "invalid JSON", JSON.stringify({ draft: true })])("falls back when installer metadata is unavailable", (metadata) => {
    expect(readBundledReleaseDownloads(metadata)).toBeNull();
  });
});
