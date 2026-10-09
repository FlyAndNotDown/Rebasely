import { useState, type ReactNode } from "react";
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
import { useGitPick, useGitSelect } from "@/state/git-context";
import { usePanelGroupLayout } from "@/state/use-panel-group-layout";

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
                <DiffViewer source="history" />
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
        <DiffViewer source="changes" />
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
            <DiffViewer source="stash" />
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
        "absolute inset-0 min-h-0 min-w-0 bg-background",
        // Hide with opacity, not visibility. Buttons use transition-all, so an
        // inherited visibility:hidden stays visible until that transition ends
        // and the controls show through the other view.
        active ? "z-10 flex" : "pointer-events-none flex opacity-0",
      )}
      inert={!active}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

export function Workspace() {
  const { view } = useGitPick(["view"]);
  const hasSnapshot = useGitSelect((state) => state.snapshot !== null);
  const [visited, setVisited] = useState({
    history: view === "history",
    stash: view === "stash",
    files: view === "files",
  });
  // Panes stay mounted once visited. Updating during render (rather than in an
  // effect) avoids a second render pass with the pane missing.
  if (view !== "changes" && !visited[view]) {
    setVisited({ ...visited, [view]: true });
  }
  const showHistory = visited.history || view === "history";
  const showStash = visited.stash || view === "stash";
  const showFiles = visited.files || view === "files";

  if (!hasSnapshot) return <WorkspaceSkeleton />;

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
