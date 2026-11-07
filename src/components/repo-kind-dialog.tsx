import { t, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VcsIcon } from "@/components/vcs-icon";
import { useGitPick } from "@/state/git-context";

export function RepoKindDialog() {
  useTranslation();
  const { kindPrompt, chooseRepoKind, dismissRepoKind } = useGitPick([
    "kindPrompt",
    "chooseRepoKind",
    "dismissRepoKind",
  ]);

  return (
    <Dialog open={kindPrompt !== null} onOpenChange={(open) => !open && dismissRepoKind()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("desktop.repoKindDialog.open_which_repository")}</DialogTitle>
          <DialogDescription>
            {t("desktop.repoKindDialog.this_folder_contains_both_a_git_repository_and")}</DialogDescription>
        </DialogHeader>
        {kindPrompt ? (
          <div className="grid gap-2">
            <Button type="button" className="h-auto justify-start px-3 py-2" onClick={() => chooseRepoKind("git")}>
              <VcsIcon vcs="git" />
              <span className="min-w-0 text-left">
                <span className="block">Git</span>
                <span className="block truncate font-mono text-[11px] font-normal opacity-80">{kindPrompt.gitPath}</span>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-auto justify-start px-3 py-2"
              onClick={() => chooseRepoKind("perforce")}
            >
              <VcsIcon vcs="perforce" />
              <span className="min-w-0 text-left">
                <span className="block">{t("desktop.repoKindDialog.perforce")}{" "}{kindPrompt.client || t("desktop.appSidebar.workspace")}</span>
                <span className="block truncate font-mono text-[11px] font-normal text-muted-foreground">
                  {kindPrompt.port || kindPrompt.root}
                </span>
              </span>
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
