import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { setLanguagePreference, t, useTranslation } from "@/i18n";
import { CircleAlertIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { AppUpdateBanner } from "@/components/app-updates";
import { AskpassDialog } from "@/components/askpass-dialog";
import { CommandCenter } from "@/components/command-palette";
import { ReflogDialog } from "@/components/lazy-dialogs";
import { RepoKindDialog } from "@/components/repo-kind-dialog";
import { WelcomeScreen } from "@/components/welcome-screen";
import { WorkspaceSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { isP4Missing, subscribeP4Availability } from "@/lib/p4";
import { WELCOME_TAB_ID, useGitPick } from "@/state/git-context";
import { useAnalytics } from "@/state/use-analytics";

const Workspace = lazy(() => import("@/components/workspace").then((module) => ({ default: module.Workspace })));
const P4Workspace = lazy(() => import("@/components/p4/p4-workspace").then((module) => ({ default: module.P4Workspace })));

export default function App() {
  useAnalytics();
  const { prefs } = useGitPick(["prefs"]);
  useEffect(() => { setLanguagePreference(prefs.language); }, [prefs.language]);
  const { activeTab, activeTabId, loading, openPanel, setOpenPanel } = useGitPick([
    "activeTab",
    "activeTabId",
    "loading",
    "openPanel",
    "setOpenPanel",
  ]);
  const perforce = activeTab.kind === "repo" && activeTab.vcs === "perforce";

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <AppHeader />
      <MissingToolsBanner />
      <AppUpdateBanner />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <div className="min-h-0 min-w-0 flex-1">
          <Suspense fallback={<WorkspaceSkeleton />}>
          {loading ? <WorkspaceSkeleton /> : activeTabId === WELCOME_TAB_ID ? (
            <WelcomeScreen />
          ) : perforce ? (
            <P4Workspace key={activeTabId} />
          ) : (
            <Workspace key={activeTabId} />
          )}
          </Suspense>
        </div>
      </div>
      <AskpassDialog />
      <RepoKindDialog />
      <CommandCenter />
      <ReflogDialog
        open={openPanel === "reflog" && activeTabId !== WELCOME_TAB_ID && !perforce}
        onOpenChange={(open) => setOpenPanel(open ? "reflog" : null)}
      />
    </div>
  );
}

function MissingToolsBanner() {
  useTranslation();
  const { gitMissing, setOpenPanel } = useGitPick(["gitMissing", "setOpenPanel"]);
  const p4Missing = useSyncExternalStore(subscribeP4Availability, isP4Missing, isP4Missing);
  if (!gitMissing && !p4Missing) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <CircleAlertIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {gitMissing ? <p>{t("desktop.dependencies.gitMissing")}</p> : null}
        {p4Missing ? <p>{t("desktop.dependencies.p4Missing")}</p> : null}
      </div>
      <Button type="button" size="sm" onClick={() => setOpenPanel("settings")}>
        {t("common.settings")}</Button>
    </div>
  );
}
