const RELEASE_PAGE = "https://github.com/FlyAndNotDown/RebaseRaven/releases/latest";
const MAX_LINK_LENGTH = 8192;

/** Resolve release-relative links without allowing webview or executable schemes. */
export function releaseNoteLink(value: string): string | undefined {
  if (!value || value.length > MAX_LINK_LENGTH || /\p{Cc}/u.test(value)) return undefined;
  try {
    const url = new URL(value, RELEASE_PAGE);
    if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (url.protocol !== "mailto:" && !url.hostname) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
