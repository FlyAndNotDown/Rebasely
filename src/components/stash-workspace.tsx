import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { usePanelGroupLayout } from "@/state/use-panel-group-layout";
import { DiffViewer } from "@/components/diff-viewer";
import { StashFiles } from "@/components/stash-files";
import { StashComposer, StashPane } from "@/components/stash-pane";

export function StashWorkspace() {
  const stash = usePanelGroupLayout("stash");
  const details = usePanelGroupLayout("stashDetails");

  return (
    <ResizablePanelGroup
      id="stash"
      groupRef={stash.groupRef}
      orientation="horizontal"
      className="min-h-0 min-w-0 flex-1"
      defaultLayout={stash.defaultLayout}
      onLayoutChanged={stash.onLayoutChanged}
    >
      <ResizablePanel id="stash-side" defaultSize="30%" minSize="22%" maxSize="52%">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1">
            <StashPane />
          </div>
          <StashComposer />
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="stash-main" defaultSize="70%" minSize="36%">
        <ResizablePanelGroup
          id="stash-details"
          groupRef={details.groupRef}
          orientation="vertical"
          className="min-h-0 min-w-0"
          defaultLayout={details.defaultLayout}
          onLayoutChanged={details.onLayoutChanged}
        >
          <ResizablePanel id="stash-files" defaultSize="28%" minSize="16%" maxSize="48%">
            <StashFiles />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="stash-diff" defaultSize="72%" minSize="30%">
            <DiffViewer source="stash" />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
