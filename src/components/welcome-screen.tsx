import { FolderOpenIcon, GitBranchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { disambiguateRepoLabels, displayPath, formatRelativeTime } from "@/lib/format";
import { useGit } from "@/state/git-context";

export function WelcomeScreen() {
  const { recents, openFolder, openPath, forgetRecent } = useGit();
  const labels = disambiguateRepoLabels(recents);

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background p-8">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden">
        <div className="mb-8 flex shrink-0 items-start gap-3">
          <div className="mt-0.5 flex size-10 items-center justify-center rounded-lg bg-foreground text-background">
            <GitBranchIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-medium tracking-tight">Rebasely</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Open a local Git repository to inspect changes, review history, and commit.
            </p>
          </div>
        </div>

        <Button onClick={() => void openFolder()} className="w-full shrink-0">
          <FolderOpenIcon data-icon="inline-start" />
          Open repository
        </Button>

        {recents.length > 0 ? (
          <div className="mt-8 flex min-h-0 flex-col overflow-hidden">
            <p className="mb-2 shrink-0 text-xs text-muted-foreground">Recent</p>
            <ul className="min-h-0 flex-1 overflow-y-auto divide-y divide-border rounded-lg border">
              {recents.map((repo) => (
                <li key={repo.path} className="flex items-center gap-2 pr-1">
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-3 py-2.5 text-left hover:bg-muted/60"
                    onClick={() => void openPath(repo.path)}
                  >
                    <div className="truncate text-sm font-medium">
                      {labels.get(repo.path) ?? repo.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {displayPath(repo.path)}
                    </div>
                  </button>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatRelativeTime(repo.lastOpened)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="mr-1"
                    onClick={() => void forgetRecent(repo.path)}
                    aria-label={`Remove ${repo.name} from recents`}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
