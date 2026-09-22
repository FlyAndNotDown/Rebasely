import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { ChangesPane } from "@/components/changes-pane";
import { CommitFiles } from "@/components/commit-files";
import { DiffViewer } from "@/components/diff-viewer";
import { HistoryBranches } from "@/components/history-branches";
import { HistoryPane } from "@/components/history-pane";
import { StashPane } from "@/components/stash-pane";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { WorkspaceSkeleton } from "@/components/skeletons";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { PanelLayoutId } from "@/types/git";

function usePanelGroupLayout(id: PanelLayoutId) {
  const { prefs, updatePanelLayout } = useGit();
  const groupRef = useGroupRef();
  const layout = prefs.panelLayouts[id];
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout(layoutRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [groupRef]);

  return {
    groupRef,
    defaultLayout: layout,
    onLayoutChanged: (next: Layout, meta: { isUserInteraction: boolean }) => {
      if (meta.isUserInteraction) updatePanelLayout(id, next);
    },
  };
}

function HistoryWorkspace() {
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
                <DiffViewer />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ChangesWorkspace() {
  const changes = usePanelGroupLayout("changes");

  return (
    <ResizablePanelGroup
      id="changes"
      groupRef={changes.groupRef}
      orientation="horizontal"
      className="min-h-0 min-w-0 flex-1"
      defaultLayout={changes.defaultLayout}
      onLayoutChanged={changes.onLayoutChanged}
    >
      <ResizablePanel id="changes-files" defaultSize="36%" minSize="24%" maxSize="52%">
        <ChangesPane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="changes-diff" defaultSize="64%" minSize="36%">
        <DiffViewer />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function StackedPane({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 min-h-0 min-w-0",
        active ? "z-10 flex" : "pointer-events-none invisible flex",
      )}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

export function Workspace() {
  const { view, snapshot } = useGit();
  const [visited, setVisited] = useState({
    history: view === "history",
    stash: view === "stash",
  });
  const showHistory = visited.history || view === "history";
  const showStash = visited.stash || view === "stash";

  useEffect(() => {
    setVisited((current) => {
      if (view === "history" && !current.history) return { ...current, history: true };
      if (view === "stash" && !current.stash) return { ...current, stash: true };
      return current;
    });
  }, [view]);

  if (!snapshot) return <WorkspaceSkeleton />;

  return (
    <div className="relative h-full min-h-0 min-w-0">
      {showStash ? (
        <StackedPane active={view === "stash"}>
          <StashPane />
        </StackedPane>
      ) : null}
      {showHistory ? (
        <StackedPane active={view === "history"}>
          <HistoryWorkspace />
        </StackedPane>
      ) : null}
      <StackedPane active={view === "changes"}>
        <ChangesWorkspace />
      </StackedPane>
    </div>
  );
}
