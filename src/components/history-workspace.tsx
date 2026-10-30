import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { usePanelGroupLayout } from "@/state/use-panel-group-layout";
import { DiffViewer } from "@/components/diff-viewer";
import { HistoryBranches } from "@/components/history-branches";
import { HistoryPane } from "@/components/history-pane";
import { CommitFiles } from "@/components/commit-files";

export function HistoryWorkspace() {
  const shell = usePanelGroupLayout("historyShell");
  const history = usePanelGroupLayout("history");
  const details = usePanelGroupLayout("historyDetails");

  return (
    <ResizablePanelGroup
      id="history-shell"
      groupRef={shell.groupRef}
      orientation="horizontal"
      className="min-h-0 min-w-0 flex-1"
      defaultLayout={shell.defaultLayout}
      onLayoutChanged={shell.onLayoutChanged}
    >
      <ResizablePanel id="history-branches" defaultSize="15%" minSize="12%" maxSize="32%">
        <HistoryBranches />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="history-main" defaultSize="85%" minSize="50%">
        <ResizablePanelGroup
          id="history"
          groupRef={history.groupRef}
          orientation="vertical"
          className="min-h-0 min-w-0"
          defaultLayout={history.defaultLayout}
          onLayoutChanged={history.onLayoutChanged}
        >
          <ResizablePanel id="history-commits" defaultSize="67%" minSize="28%">
            <HistoryPane />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="history-details" defaultSize="33%" minSize="18%">
            <ResizablePanelGroup
              id="history-details"
              groupRef={details.groupRef}
              orientation="horizontal"
              className="min-h-0 min-w-0"
              defaultLayout={details.defaultLayout}
              onLayoutChanged={details.onLayoutChanged}
            >
              <ResizablePanel id="history-files" defaultSize="34%" minSize="20%" maxSize="55%">
                <CommitFiles />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="history-diff" defaultSize="66%" minSize="30%">
                <DiffViewer source="history" />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
