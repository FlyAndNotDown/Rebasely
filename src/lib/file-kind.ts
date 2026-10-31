export function fileKindLabel(kind: string): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
    case "typechange":
      return "T";
    case "copied":
      return "C";
    default:
      return "M";
  }
}

export function fileKindClass(kind: string): string {
  switch (kind) {
    case "added":
    case "untracked":
      return "text-diff-add";
    case "deleted":
    case "conflicted":
      return "text-diff-del";
    case "renamed":
    case "copied":
      return "text-diff-hunk";
    default:
      return "text-amber-600 dark:text-amber-400";
  }
}
