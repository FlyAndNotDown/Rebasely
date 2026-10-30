import { lazy, Suspense, useState, type ReactNode } from "react";
import { ChangesPane } from "@/components/changes-pane";
import { RebaseBanner } from "@/components/rebase-dialog";
import { DiffViewer } from "@/components/diff-viewer";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { WorkspaceSkeleton } from "@/components/skeletons";
import { cn } from "@/lib/utils";
import { useGitPick, useGitSelect } from "@/state/git-context";
import { usePanelGroupLayout } from "@/state/use-panel-group-layout";

const HistoryWorkspace = lazy(() => import("@/components/history-workspace").then((module) => ({ default: module.HistoryWorkspace })));
const StashWorkspace = lazy(() => import("@/components/stash-workspace").then((module) => ({ default: module.StashWorkspace })));
const FilesBrowser = lazy(() => import("@/components/files-browser").then((module) => ({ default: module.FilesBrowser })));

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
      <Suspense fallback={<WorkspaceSkeleton />}>{children}</Suspense>
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
