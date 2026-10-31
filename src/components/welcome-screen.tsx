import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { ArrowRightIcon, ClockIcon, DownloadIcon, FolderOpenIcon, GitCommitHorizontalIcon, HistoryIcon, PlusIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import { AppMark } from "@/components/app-mark";
import { CloneRepositoryDialog, InitializeRepositoryDialog } from "@/components/lazy-dialogs";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { VcsIcon } from "@/components/vcs-icon";
import { disambiguateRepoLabels, displayPath, formatRelativeTime } from "@/lib/format";
import { formatCombo, SHORTCUTS } from "@/lib/shortcuts";
import { useGitPick } from "@/state/git-context";
import { asVcs } from "@/state/session";

export function WelcomeScreen() {
  useTranslation();
  const { recents, openFolder, openPath, forgetRecent, setOpenPanel } = useGitPick([
    "recents", "openFolder", "openPath", "forgetRecent", "setOpenPanel",
  ]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [initializeOpen, setInitializeOpen] = useState(false);
  const labels = disambiguateRepoLabels(recents);

  return (
    <ScrollArea className="h-full">
      <main className="mx-auto w-full max-w-5xl px-8 py-10 lg:px-12 lg:py-14">
        <div className="mb-10 flex items-center gap-3">
          <AppMark className="size-11" iconClassName="size-6" />
          <div>
            <p className="text-sm font-medium">Rebasely</p>
            <p className="text-xs text-muted-foreground">{t("desktop.welcomeScreen.a_unified_version_control_client")}</p>
          </div>
        </div>
        <div className="grid gap-10 md:grid-cols-[1fr_1fr] lg:gap-14">
          <section aria-labelledby="welcome-title">
            <h1 id="welcome-title" className="text-3xl font-medium tracking-tight">{t("desktop.welcomeScreen.make_your_next_change")}</h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {t("desktop.welcomeScreen.open_a_git_repository_or_perforce_workspace_review")}</p>
            <div className="mt-7 space-y-3">
              <Button className="h-auto w-full justify-start gap-3 px-4 py-3 text-left" onClick={() => void openFolder()}>
                <FolderOpenIcon className="size-5 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span>{t("desktop.appMenu.open_local_repository")}</span>
                  <span className="text-xs font-normal opacity-70">{t("desktop.welcomeScreen.choose_a_repository_or_workspace_folder")}</span>
                </span>
                <Kbd className="shrink-0 bg-primary-foreground/15 text-primary-foreground">{formatCombo(SHORTCUTS.openRepository[0])}</Kbd>
              </Button>
              <Button variant="outline" className="h-auto w-full justify-start gap-3 px-4 py-3 text-left" onClick={() => setCloneOpen(true)}>
                <DownloadIcon className="size-5 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span>{t("desktop.appMenu.open_remote_repository")}</span>
                  <span className="text-xs font-normal text-muted-foreground">{t("desktop.welcomeScreen.clone_git_or_connect_to_perforce")}</span>
                </span>
                <ArrowRightIcon className="size-4 text-muted-foreground" />
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setInitializeOpen(true)}><PlusIcon />{t("desktop.appMenu.create_git_repository")}</Button>
            <div className="mt-7 space-y-4 border-t pt-6">
              <WelcomeStep icon={SearchIcon} title={t("desktop.welcomeScreen.review_changes")} detail={t("desktop.welcomeScreen.inspect_files_and_stage_exactly_what_belongs_together")} />
              <WelcomeStep icon={GitCommitHorizontalIcon} title={t("desktop.welcomeScreen.keep_work_organized")} detail={t("desktop.welcomeScreen.commit_shelve_or_set_changes_aside_for_later")} />
              <WelcomeStep icon={HistoryIcon} title={t("desktop.welcomeScreen.follow_the_history")} detail={t("desktop.welcomeScreen.explore_branches_revisions_and_file_changes")} />
            </div>
          </section>
          <section aria-labelledby="recent-title" className="min-w-0">
            <div className="mb-3 flex h-7 items-center gap-2">
              <ClockIcon className="size-4 text-muted-foreground" />
              <h2 id="recent-title" className="text-sm font-medium">{t("desktop.appMenu.recent_repositories")}</h2>
              {recents.length ? <span className="ml-auto text-xs text-muted-foreground">{recents.length}</span> : null}
            </div>
            {recents.length ? (
              <ScrollArea className="max-h-[380px] rounded-lg border [&_[data-slot=scroll-area-viewport]]:max-h-[380px]">
                <ul className="divide-y divide-border">
                  {recents.map((repo) => (
                    <li key={`${asVcs(repo.vcs)}:${repo.path}`} className="flex items-center gap-2 pr-1">
                      <HoverTip label={displayPath(repo.path)}>
                        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => void openPath(repo.path, repo.vcs ? asVcs(repo.vcs) : undefined)}>
                          <VcsIcon vcs={asVcs(repo.vcs)} className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{asVcs(repo.vcs) === "perforce" ? repo.name : labels.get(repo.path) ?? repo.name}</span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{displayPath(repo.path)}</span>
                          </span>
                        </button>
                      </HoverTip>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelativeTime(repo.lastOpened)}</span>
                      <HoverTip label={t("desktop.welcomeScreen.remove_from_recents")}>
                        <Button variant="ghost" size="icon-xs" className="mr-1" onClick={() => void forgetRecent(repo.path)} aria-label={t("desktop.welcomeScreen.removeRecent", { name: repo.name })}><XIcon /></Button>
                      </HoverTip>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            ) : (
              <div className="flex min-h-60 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
                <FolderOpenIcon className="mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">{t("desktop.welcomeScreen.start_with_a_repository")}</p>
                <p className="mt-1 max-w-56 text-xs leading-relaxed text-muted-foreground">{t("desktop.welcomeScreen.your_recently_opened_repositories_will_appear_here")}</p>
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpenPanel("settings")}><SettingsIcon />{t("desktop.welcomeScreen.set_up_tools")}</Button>
              <Button variant="ghost" size="sm" onClick={() => setOpenPanel("palette")}><SearchIcon />{t("desktop.welcomeScreen.commands")}<Kbd>{formatCombo(SHORTCUTS.palette[0])}</Kbd></Button>
            </div>
          </section>
        </div>
      </main>
      <CloneRepositoryDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      <InitializeRepositoryDialog open={initializeOpen} onOpenChange={setInitializeOpen} />
    </ScrollArea>
  );
}

function WelcomeStep({ icon: Icon, title, detail }: { icon: typeof SearchIcon; title: string; detail: string }) {

  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div><p className="text-xs font-medium">{title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p></div>
    </div>
  );
}
