import { useLayoutEffect } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
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

const HISTORY_LAYOUT: Layout = { "history-commits": 67, "history-details": 33 };
let historyLayout: Layout = HISTORY_LAYOUT;

function HistoryWorkspace() {
  const groupRef = useGroupRef();

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout(historyLayout);
    });
    return () => cancelAnimationFrame(frame);
  }, [groupRef]);

  return (
    <ResizablePanelGroup
      id="history"
      groupRef={groupRef}
      orientation="vertical"
      className="min-h-0 flex-1"
      defaultLayout={HISTORY_LAYOUT}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) historyLayout = layout;
      }}
    >
      <ResizablePanel id="history-commits" defaultSize="67%" minSize="28%">
        <HistoryPane />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="history-details" defaultSize="33%" minSize="18%">
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
  );
}

export function Workspace() {
  const { view } = useGit();

  return (
    <div className="flex h-full min-h-0">
      {view === "stash" ? (
        <StashPane />
      ) : view === "history" ? (
        <HistoryWorkspace />
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
