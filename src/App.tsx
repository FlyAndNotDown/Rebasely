import { WelcomeScreen } from "@/components/welcome-screen";
import { Workspace } from "@/components/workspace";
import { useGit } from "@/state/git-context";

export default function App() {
  const { snapshot, loading } = useGit();

  if (loading) {
    return <div className="h-full bg-background" />;
  }

  return snapshot ? <Workspace /> : <WelcomeScreen />;
}
