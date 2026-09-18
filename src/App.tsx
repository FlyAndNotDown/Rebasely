import { AppHeader } from "@/components/app-header";
import { WelcomeScreen } from "@/components/welcome-screen";
import { Workspace } from "@/components/workspace";
import { useGit } from "@/state/git-context";

export default function App() {
  const { activeTab, loading } = useGit();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <AppHeader />
      <div className="min-h-0 flex-1">
        {loading ? null : activeTab.kind === "welcome" ? (
          <WelcomeScreen />
        ) : (
          <Workspace key={activeTab.id} />
        )}
      </div>
    </div>
  );
}
