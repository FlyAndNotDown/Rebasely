import type { VcsKind } from "@/state/session";
import { cn } from "@/lib/utils";

export function VcsIcon({
  vcs,
  className,
}: {
  vcs: VcsKind | "git" | "perforce";
  className?: string;
}) {
  if (vcs === "perforce") return <PerforceMark className={className} />;
  return <GitLogo className={className} />;
}

/** Official Git mark from https://git-scm.com/images/logos/downloads/Git-Icon-1788C.svg */
export function GitLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 78 78"
      aria-hidden="true"
      className={cn("size-4", className)}
    >
      <path
        fill="currentColor"
        transform="translate(10 10) rotate(-45 29 29)"
        d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"
      />
    </svg>
  );
}

/** Official Perforce logomark from https://simpleicons.org/icons/perforce.svg */
export function PerforceMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-4", className)}>
      <path
        fill="currentColor"
        transform="translate(1.56 1.56) scale(0.87)"
        d="m7.386 14.957 2.279-1.316-.576-.333A1.48 1.48 0 0 1 8.334 12c0-.262.073-.915.755-1.308l10.31-5.953a1.49 1.49 0 0 1 1.51 0c.228.13.755.52.755 1.308v11.906c0 .788-.527 1.178-.754 1.308s-.828.393-1.51 0l-2.732-1.577-2.334 1.348 3.899 2.251a3.81 3.81 0 0 0 3.845 0A3.81 3.81 0 0 0 24 17.953V6.047a3.81 3.81 0 0 0-1.922-3.33 3.83 3.83 0 0 0-1.923-.52c-.66 0-1.32.173-1.922.52L7.923 8.67A3.81 3.81 0 0 0 6 12c0 1.17.51 2.234 1.386 2.956zm9.228-5.913-2.279 1.316.576.333c.682.393.755 1.046.755 1.308 0 .263-.073.915-.755 1.308l-10.31 5.954a1.49 1.49 0 0 1-1.51 0 1.48 1.48 0 0 1-.755-1.308V6.047c0-.788.527-1.178.754-1.308s.828-.393 1.51 0l2.732 1.577 2.334-1.348-3.899-2.251a3.81 3.81 0 0 0-3.845 0A3.81 3.81 0 0 0 0 6.047v11.906c0 1.39.72 2.635 1.922 3.33a3.83 3.83 0 0 0 1.923.52c.66 0 1.32-.173 1.922-.52l10.31-5.953A3.81 3.81 0 0 0 18 12c0-1.17-.51-2.234-1.386-2.956"
      />
    </svg>
  );
}
