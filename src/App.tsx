import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { WelcomeScreen } from "@/components/welcome-screen";
import { Workspace } from "@/components/workspace";
import { useGit } from "@/state/git-context";

export default function App() {
  const { activeTab, loading } = useGit();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <div className="min-h-0 min-w-0 flex-1">
          {loading ? null : activeTab.kind === "welcome" ? (
            <WelcomeScreen />
          ) : (
            <Workspace key={activeTab.id} />
          )}
        </div>
      </div>
    </div>
  );
}
