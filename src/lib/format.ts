import { formatDate, t } from "@/i18n";

function formatCalendarDate(date: Date, withYear: boolean): string {
  return formatDate(date, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } as const : {}) });
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const then = timestamp * 1000;
  const delta = Math.max(0, now - then);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const date = new Date(then);

  if (delta < minute) return t("time.now");
  if (delta < hour) {
    const value = Math.floor(delta / minute);
    return t("time.minutes", { count: value });
  }
  if (delta < day) {
    const value = Math.floor(delta / hour);
    return t("time.hours", { count: value });
  }
  if (delta < 7 * day) {
    const value = Math.floor(delta / day);
    return t("time.days", { count: value });
  }
  return formatCalendarDate(date, date.getFullYear() !== new Date().getFullYear());
}

/** Calendar date for the blame gutter, zero-padded so columns line up: 2014-03-16. */
export function formatBlameWhen(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/** Absolute time with seconds, for a tooltip beside the minute-precision label. */
export function formatExactTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${formatAbsoluteTime(timestamp)}:${seconds}`;
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
  let text = path;
  if (path.startsWith("\\\\?\\UNC\\")) {
    text = `\\\\${path.slice(8)}`;
  } else if (path.startsWith("\\\\?\\")) {
    text = path.slice(4);
  }
  return text.normalize("NFC");
}

function runtimePlatform(): string {
  const runtime = globalThis as { process?: { platform?: string } };
  return runtime.process?.platform ?? "";
}

/** Only Windows can safely fold path case without probing the filesystem. */
export function pathsIgnoreCase(): boolean {
  const agent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/windows/i.test(agent)) return true;
  if (/linux|macintosh|mac os x/i.test(agent)) return false;
  const platform = runtimePlatform();
  return platform === "win32";
}

export function foldRepoPath(path: string, ignoreCase: boolean): string {
  if (ignoreCase) {
    const plain = path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.startsWith("\\\\?\\") ? path.slice(4) : path;
    return plain.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }
  return path === "/" ? path : path.replace(/\/+$/, "");
}

export function normalizeRepoPath(path: string): string {
  return foldRepoPath(path, pathsIgnoreCase());
}

export function sameRepoPath(a: string, b: string): boolean {
  return normalizeRepoPath(a) === normalizeRepoPath(b);
}

export function pathSegments(path: string): string[] {
  return displayPath(path)
    .replace(/[/\\]+$/, "")
    .split(/[/\\]+/)
    .filter(Boolean);
}

export function disambiguateRepoLabels(repos: { path: string; name: string }[]): Map<string, string> {
  const items = repos.map((repo) => {
    const segments = pathSegments(repo.path);
    return {
      path: repo.path,
      name: repo.name || segments[segments.length - 1] || "repository",
      segments,
    };
  });
  const labels = new Map<string, string>();
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      labels.set(group[0].path, group[0].name);
      continue;
    }

    const maxDepth = Math.max(...group.map((item) => item.segments.length), 2);
    let assigned = false;
    for (let depth = 2; depth <= maxDepth; depth += 1) {
      const next = group.map((item) => ({
        path: item.path,
        label: repoLabelAtDepth(item.name, item.segments, depth),
      }));
      const counts = new Map<string, number>();
      for (const item of next) {
        const key = item.label.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      if (next.every((item) => counts.get(item.label.toLowerCase()) === 1) || depth === maxDepth) {
        for (const item of next) labels.set(item.path, item.label);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      for (const item of group) labels.set(item.path, item.name);
    }
  }
  return labels;
}

function repoLabelAtDepth(name: string, segments: string[], depth: number): string {
  if (depth <= 1 || segments.length <= 1) return name;
  const used = Math.min(depth, segments.length);
  const parents = segments.slice(-used, -1);
  return parents.length > 0 ? `${name} (${parents.join("/")})` : name;
}
