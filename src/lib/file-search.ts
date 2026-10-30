export interface SearchNode {
  relative: string;
  dir: boolean;
  status?: string;
  detail?: string;
}

const byName = new Intl.Collator(undefined, { sensitivity: "base" }).compare;

/** Builds the ancestor folders for a filtered file list and expands those folders. */
export function nestSearchNodes(nodes: SearchNode[]): {
  entries: Record<string, SearchNode[]>;
  open: string[];
} {
  const buckets = new Map<string, Map<string, SearchNode>>();
  const open = new Set<string>();

  function bucket(parent: string) {
    let map = buckets.get(parent);
    if (!map) {
      map = new Map();
      buckets.set(parent, map);
    }
    return map;
  }

  function addDir(relative: string, expand: boolean) {
    const parts = relative.split("/").filter(Boolean);
    let parent = "";
    for (let index = 0; index < parts.length; index += 1) {
      const path = parent ? `${parent}/${parts[index]}` : parts[index];
      const map = bucket(parent);
      const existing = map.get(path);
      if (!existing || existing.dir) {
        map.set(path, { relative: path, dir: true });
      }
      const last = index === parts.length - 1;
      if (!last || expand) open.add(path);
      parent = path;
    }
  }

  for (const node of nodes) {
    const relative = node.relative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!relative || relative.split("/").includes("..")) continue;
    if (node.dir) {
      addDir(relative, false);
      continue;
    }
    const slash = relative.lastIndexOf("/");
    const parent = slash >= 0 ? relative.slice(0, slash) : "";
    if (parent) addDir(parent, true);
    bucket(parent).set(relative, {
      relative,
      dir: false,
      status: node.status ?? "",
      detail: node.detail ?? "",
    });
  }

  const entries: Record<string, SearchNode[]> = {};
  for (const [parent, map] of buckets) {
    entries[parent] = [...map.values()].sort((left, right) => {
      if (left.dir !== right.dir) return left.dir ? -1 : 1;
      return byName(baseName(left.relative), baseName(right.relative));
    });
  }
  return { entries, open: [...open] };
}

function baseName(relative: string) {
  const slash = relative.lastIndexOf("/");
  return slash >= 0 ? relative.slice(slash + 1) : relative;
}

export function joinRoot(root: string, relative: string) {
  if (!relative) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/, "")}${separator}${relative.split("/").join(separator)}`;
}
