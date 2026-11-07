import { t } from "@/i18n";

// Keep command output intact; translate only the application's known status grammar.
const statusKeys: Record<string, string> = {
  "Locked by you": "lockedByYou",
  "Locked by another user": "lockedOther", "Opened by another user": "openedOther",
  "Checked out for edit": "edit", "Checked out, no changes": "unchanged",
  "Marked for add": "add", "Marked for delete": "delete", "Opened for integrate": "integrate",
  "Needs resolve": "needsResolve", "Not latest": "notLatest", "Not synced": "notSynced",
  "Up to date": "current", "Not in the depot": "local",
};
const numberedStatus: [string, string][] = [
  ["Your changelist ", "yourChangelist"], ["Changelist ", "changelist"],
  ["Have revision ", "haveRevision"], ["Head revision ", "headRevision"], ["Revision ", "revision"],
];

export function p4DisplayText(line: string): string {
  if (statusKeys[line]) return t(`p4.status.${statusKeys[line]}`);
  for (const [prefix, key] of numberedStatus) {
    if (line.startsWith(prefix)) return t(`p4.status.${key}`, { value: line.slice(prefix.length) });
  }
  const opener = /^(Locked by|Opened by) (.+)$/.exec(line);
  if (opener) {
    const change = /^(.*) in changelist (\d+)$/.exec(opener[2]);
    const owner = change?.[1] ?? opener[2];
    const client = /^(\S+) on (\S+)$/.exec(owner);
    let value = client ? t("p4.status.owner", { user: client[1], client: client[2] }) : owner;
    if (change) value = t("p4.status.ownerChange", { owner: value, change: change[2] });
    return t(opener[1] === "Locked by" ? "p4.status.lockedBy" : "p4.status.openedBy", { value });
  }
  const more = /^(\d+) more users? ha(?:s|ve) this file open$/.exec(line);
  if (more) return t("p4.status.moreUsers", { count: Number(more[1]) });
  if (line === "Use a file name, or //depot/name.") return t("p4.searchPathHint");
  if (line === "Type at least 2 characters.") return t("p4.searchMinimum");
  if (line.startsWith("In ")) return t("p4.inScope", { scope: line.slice(3) });
  const merge = /^Merging (.+) using base (.+)$/.exec(line);
  if (merge) return t("p4.resolveSummary.mergingBase", { source: merge[1], base: merge[2] });
  const resolve = /^(Deleting|Branching|Moving|Changing type from|Merging) (.+)$/.exec(line);
  if (resolve) {
    const key = { Deleting: "deleting", Branching: "branching", Moving: "moving", "Changing type from": "changingType", Merging: "merging" }[resolve[1]];
    return t(`p4.resolveSummary.${key}`, { source: resolve[2] });
  }
  return line;
}
