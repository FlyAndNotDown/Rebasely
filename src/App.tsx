import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { AskpassDialog } from "@/components/askpass-dialog";
import { WelcomeScreen } from "@/components/welcome-screen";
import { Workspace } from "@/components/workspace";
import { WELCOME_TAB_ID, useGitPick } from "@/state/git-context";

export default function App() {
  const { activeTabId, loading } = useGitPick(["activeTabId", "loading"]);

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
    </div>
  );
}
