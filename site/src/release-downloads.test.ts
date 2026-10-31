import { describe, expect, it, vi } from "vitest";
import { fetchReleaseDownloads, LATEST_RELEASE_API, parseReleaseDownloads, REPOSITORY_URL } from "./release-downloads";

function asset(name: string, tag = "v1.2.3") {
  return { name, state: "uploaded", browser_download_url: `${REPOSITORY_URL}/releases/download/${tag}/${name}` };
}

function release(assets: unknown[] = []) {
  return { tag_name: "v1.2.3", draft: false, prerelease: false, assets };
}

describe("website release downloads", () => {
  it("resolves matching platform installers from the returned version", () => {
    expect(parseReleaseDownloads(release([
      asset("Rebasely_v1.2.3_macos_arm64.dmg"),
      asset("Rebasely_v1.2.3_windows_x64.exe"),
      asset("Rebasely_v1.2.3_linux_x64.AppImage"),
      asset("Rebasely_v1.2.3_macos_x64.dmg"),
      asset("Rebasely_v1.2.3_macos_arm64.app.tar.gz"),
    ]))).toEqual({
      tag: "v1.2.3",
      macos: `${REPOSITORY_URL}/releases/download/v1.2.3/Rebasely_v1.2.3_macos_arm64.dmg`,
      windows: `${REPOSITORY_URL}/releases/download/v1.2.3/Rebasely_v1.2.3_windows_x64.exe`,
    });
  });

  it("prefers the Windows executable and can use an MSI installer", () => {
    const msi = asset("Rebasely_v1.2.3_windows_x64.msi");
    const exe = asset("Rebasely_v1.2.3_windows_x64.exe");
    expect(parseReleaseDownloads(release([msi, exe])).windows).toBe(exe.browser_download_url);
    expect(parseReleaseDownloads(release([msi])).windows).toBe(msi.browser_download_url);
  });

  it.each([
    "https://elsewhere.example/installer.dmg",
    "https://github.com/another/repository/releases/download/v1.2.3/Rebasely_v1.2.3_macos_arm64.dmg",
    `${REPOSITORY_URL}/releases/download/v9.9.9/Rebasely_v1.2.3_macos_arm64.dmg`,
    `${REPOSITORY_URL}/releases/download/v1.2.3/Rebasely_v1.2.3_macos_arm64.dmg?token=example`,
    "https://alice:example-password@github.com/FlyAndNotDown/Rebasely/releases/download/v1.2.3/Rebasely_v1.2.3_macos_arm64.dmg",
  ])("does not expose untrusted or mismatched download URL %s", (url) => {
    const installer = { ...asset("Rebasely_v1.2.3_macos_arm64.dmg"), browser_download_url: url };
    expect(parseReleaseDownloads(release([installer])).macos).toBeUndefined();
  });

  it("keeps missing or incomplete assets available for the latest-release fallback", () => {
    expect(parseReleaseDownloads(release())).toEqual({ tag: "v1.2.3" });
    expect(parseReleaseDownloads(release([{ ...asset("Rebasely_v1.2.3_macos_arm64.dmg"), state: "open" }])).macos).toBeUndefined();
  });

  it.each([null, {}, { ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), tag_name: "../other" }])("rejects invalid stable-release metadata", (value) => {
    expect(() => parseReleaseDownloads(value)).toThrow("Latest release information is unavailable.");
  });

  it("uses only the fixed anonymous API and forwards cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(release())));
    await fetchReleaseDownloads(controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith(LATEST_RELEASE_API, {
      signal: controller.signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
  });

  it("handles rate limits without displaying the response body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private upstream details", { status: 403 }));
    await expect(fetchReleaseDownloads(new AbortController().signal, fetcher)).rejects.toThrow("Latest release information is unavailable.");
  });
});
