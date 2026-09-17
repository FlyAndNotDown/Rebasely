import { AppHeader } from "@/components/app-header";
import { ChangesPane } from "@/components/changes-pane";
import { DiffViewer } from "@/components/diff-viewer";
import { HistoryPane } from "@/components/history-pane";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useGit } from "@/state/git-context";

export function Workspace() {
  const { view } = useGit();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppHeader />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="28%" minSize="20%" maxSize="45%">
          {view === "changes" ? <ChangesPane /> : <HistoryPane />}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="72%" minSize="40%">
          <DiffViewer />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
