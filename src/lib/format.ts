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
