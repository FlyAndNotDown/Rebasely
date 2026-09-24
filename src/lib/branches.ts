import type { BranchInfo } from "@/types/git";

export function shortRemoteName(fullName: string, remoteName: string) {
  const prefix = `${remoteName}/`;
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
}

export function remoteGroupRank(name: string) {
  return name === "origin" ? 0 : 1;
}

export function defaultBranchRank(shortName: string) {
  const base = shortName.split("/").pop() ?? shortName;
  if (base === "main") return 0;
  if (base === "master") return 1;
  if (base === "develop") return 2;
  return 3;
}

/**
 * Remote branches grouped by remote: origin first, then by name. Within a
 * remote, main, master, and develop come first. `extraNames` adds remotes that
 * have no branches yet so they still get a group.
 */
export function groupRemoteBranches(
  branches: BranchInfo[],
  extraNames: string[] = [],
): [string, BranchInfo[]][] {
  const groups = new Map<string, BranchInfo[]>();
  for (const name of extraNames) groups.set(name, []);
  for (const branch of branches) {
    const slash = branch.name.indexOf("/");
    const remote = slash === -1 ? branch.name : branch.name.slice(0, slash);
    const list = groups.get(remote) ?? [];
    list.push(branch);
    groups.set(remote, list);
  }
  for (const [remote, list] of groups) {
    list.sort((left, right) => {
      const leftName = shortRemoteName(left.name, remote);
      const rightName = shortRemoteName(right.name, remote);
      const rank = defaultBranchRank(leftName) - defaultBranchRank(rightName);
      return rank !== 0 ? rank : leftName.localeCompare(rightName);
    });
  }
  return [...groups.entries()].sort(([left], [right]) => {
    const rank = remoteGroupRank(left) - remoteGroupRank(right);
    return rank !== 0 ? rank : left.localeCompare(right);
  });
}
