import { CircleAlertIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { AskpassDialog } from "@/components/askpass-dialog";
import { CommandCenter } from "@/components/command-palette";
import { ReflogDialog } from "@/components/lazy-dialogs";
import { WelcomeScreen } from "@/components/welcome-screen";
import { Workspace } from "@/components/workspace";
import { Button } from "@/components/ui/button";
import { WindowResizeBorders } from "@/components/window-controls";
import { GIT_MISSING } from "@/lib/git";
import { WELCOME_TAB_ID, useGitPick } from "@/state/git-context";

export default function App() {
  const { activeTabId, loading, openPanel, setOpenPanel } = useGitPick([
    "activeTabId",
    "loading",
    "openPanel",
    "setOpenPanel",
  ]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <WindowResizeBorders />
      <AppHeader />
      <MissingGitBanner />
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

function MissingGitBanner() {
  const { gitMissing, setOpenPanel } = useGitPick(["gitMissing", "setOpenPanel"]);
  if (!gitMissing) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <CircleAlertIcon className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">{GIT_MISSING}</p>
      <Button type="button" size="sm" onClick={() => setOpenPanel("settings")}>
        Settings
      </Button>
    </div>
  );
}
