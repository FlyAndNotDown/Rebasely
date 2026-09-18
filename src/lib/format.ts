const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatEnglishDate(date: Date, withYear: boolean): string {
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  if (!withYear) return `${month} ${day}`;
  return `${month} ${day}, ${date.getFullYear()}`;
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const then = timestamp * 1000;
  const delta = Math.max(0, now - then);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const date = new Date(then);

  if (delta < minute) return "just now";
  if (delta < hour) {
    const value = Math.floor(delta / minute);
    return `${value}m ago`;
  }
  if (delta < day) {
    const value = Math.floor(delta / hour);
    return `${value}h ago`;
  }
  if (delta < 7 * day) {
    const value = Math.floor(delta / day);
    return `${value}d ago`;
  }
  return formatEnglishDate(date, date.getFullYear() !== new Date().getFullYear());
}

export function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour12 = hours % 12 || 12;
  const suffix = hours < 12 ? "AM" : "PM";
  return `${formatEnglishDate(date, true)}, ${hour12}:${minutes} ${suffix}`;
}

export function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice(8)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice(4);
  }
  return path;
}

export function normalizeRepoPath(path: string): string {
  return displayPath(path).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function sameRepoPath(a: string, b: string): boolean {
  return normalizeRepoPath(a) === normalizeRepoPath(b);
}
