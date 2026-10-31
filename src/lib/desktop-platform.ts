export type DesktopPlatform = "macos" | "windows" | "linux";

export function desktopPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
): DesktopPlatform {
  if (/mac/i.test(platform)) return "macos";
  if (/win/i.test(platform)) return "windows";
  return "linux";
}
