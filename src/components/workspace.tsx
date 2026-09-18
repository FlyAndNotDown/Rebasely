import { ChangesPane } from "@/components/changes-pane";
import { CommitFiles } from "@/components/commit-files";
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
      {view === "history" ? (
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="40%" minSize="22%">
            <HistoryPane />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="60%" minSize="28%">
            <ResizablePanelGroup orientation="horizontal" className="min-h-0">
              <ResizablePanel defaultSize="34%" minSize="20%" maxSize="55%">
                <CommitFiles />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="66%" minSize="30%">
                <DiffViewer />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="36%" minSize="24%" maxSize="52%">
            <ChangesPane />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="64%" minSize="36%">
            <DiffViewer />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
