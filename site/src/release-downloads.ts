export const REPOSITORY_URL = "https://github.com/FlyAndNotDown/Rebasely";
export const LATEST_RELEASE_URL = `${REPOSITORY_URL}/releases/latest`;
export const LATEST_RELEASE_API = "https://api.github.com/repos/FlyAndNotDown/Rebasely/releases/latest";

export type ReleaseDownloads = {
  tag: string;
  macos?: string;
  windows?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseDownloads(value: unknown): ReleaseDownloads {
  if (!record(value) || typeof value.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(value.tag_name)
    || value.draft !== false || value.prerelease !== false || !Array.isArray(value.assets)) {
    throw new Error("Latest release information is unavailable.");
  }
  const tag = value.tag_name;
  const filenames = {
    macos: [`Rebasely_${tag}_macos_arm64.dmg`],
    windows: [`Rebasely_${tag}_windows_x64.exe`, `Rebasely_${tag}_windows_x64.msi`],
  };
  const result: ReleaseDownloads = { tag };
  for (const platform of ["macos", "windows"] as const) {
    for (const name of filenames[platform]) {
      const expected = `${REPOSITORY_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
      const asset = value.assets.find((asset: unknown) => record(asset)
        && asset.name === name && asset.browser_download_url === expected && asset.state === "uploaded");
      if (asset) {
        result[platform] = expected;
        break;
      }
    }
  }
  return result;
}

export async function fetchReleaseDownloads(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ReleaseDownloads> {
  const response = await fetcher(LATEST_RELEASE_API, {
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Latest release information is unavailable.");
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("Latest release information is unavailable."); }
  return parseReleaseDownloads(value);
}
