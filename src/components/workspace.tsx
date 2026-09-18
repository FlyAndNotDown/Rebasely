import { AppSidebar } from "@/components/app-sidebar";
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
    <div className="flex h-full min-h-0">
      <AppSidebar />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="36%" minSize="24%" maxSize="52%">
          {view === "changes" ? <ChangesPane /> : <HistoryPane />}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="64%" minSize="36%">
          <DiffViewer />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
