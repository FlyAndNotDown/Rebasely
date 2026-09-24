import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { ChangesPane } from "@/components/changes-pane";
import { RebaseBanner } from "@/components/rebase-dialog";
import { CommitFiles } from "@/components/commit-files";
import { DiffViewer } from "@/components/diff-viewer";
import { HistoryBranches } from "@/components/history-branches";
import { FilesBrowser } from "@/components/files-browser";
import { HistoryPane } from "@/components/history-pane";
import { StashFiles } from "@/components/stash-files";
import { StashComposer, StashPane } from "@/components/stash-pane";
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

function StashWorkspace() {
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
            <DiffViewer />
          </ResizablePanel>
        </ResizablePanelGroup>
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
    files: view === "files",
  });
  const showHistory = visited.history || view === "history";
  const showStash = visited.stash || view === "stash";
  const showFiles = visited.files || view === "files";

  useEffect(() => {
    setVisited((current) => {
      if (view === "history" && !current.history) return { ...current, history: true };
      if (view === "stash" && !current.stash) return { ...current, stash: true };
      if (view === "files" && !current.files) return { ...current, files: true };
      return current;
    });
  }, [view]);

  if (!snapshot) return <WorkspaceSkeleton />;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <RebaseBanner />
      <div className="relative min-h-0 flex-1">
      {showStash ? (
        <StackedPane active={view === "stash"}>
          <StashWorkspace />
        </StackedPane>
      ) : null}
      {showFiles ? (
        <StackedPane active={view === "files"}>
          <FilesBrowser />
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
    </div>
  );
}
