export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const then = timestamp * 1000;
  const delta = Math.max(0, now - then);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

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
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(then).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}
