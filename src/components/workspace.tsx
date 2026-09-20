import { ChangesPane } from "@/components/changes-pane";
import { CommitFiles } from "@/components/commit-files";
import { DiffViewer } from "@/components/diff-viewer";
import { HistoryPane } from "@/components/history-pane";
import { StashPane } from "@/components/stash-pane";
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
      {view === "stash" ? (
        <StashPane />
      ) : view === "history" ? (
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="67%" minSize="28%">
            <HistoryPane />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="33%" minSize="18%">
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
