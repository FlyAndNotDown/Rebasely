import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { AskpassDialog } from "@/components/askpass-dialog";
import { CommandCenter } from "@/components/command-palette";
import { ReflogDialog } from "@/components/lazy-dialogs";
import { WelcomeScreen } from "@/components/welcome-screen";
import { Workspace } from "@/components/workspace";
import { WELCOME_TAB_ID, useGitPick } from "@/state/git-context";

export default function App() {
  const { activeTabId, loading, openPanel, setOpenPanel } = useGitPick([
    "activeTabId",
    "loading",
    "openPanel",
    "setOpenPanel",
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <div className="min-h-0 min-w-0 flex-1">
          {loading ? null : activeTabId === WELCOME_TAB_ID ? (
            <WelcomeScreen />
          ) : (
            <Workspace key={activeTabId} />
          )}
        </div>
      </div>
      <AskpassDialog />
      <CommandCenter />
      <ReflogDialog
        open={openPanel === "reflog" && activeTabId !== WELCOME_TAB_ID}
        onOpenChange={(open) => setOpenPanel(open ? "reflog" : null)}
      />
    </div>
  );
}
