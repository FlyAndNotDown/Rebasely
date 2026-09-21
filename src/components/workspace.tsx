import { useEffect, useRef, useState } from "react";
import { type Layout } from "react-resizable-panels";
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
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { PanelLayoutId } from "@/types/git";

function HistoryWorkspace() {
  const { prefs, updatePanelLayout } = useGit();
  const layouts = useRef(prefs.panelLayouts);
  const persist = (id: PanelLayoutId) => (layout: Layout, meta: { isUserInteraction: boolean }) => {
    if (meta.isUserInteraction) updatePanelLayout(id, layout);
  };

  return (
    <ResizablePanelGroup
      id="history-shell"
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={layouts.current.historyShell}
      onLayoutChanged={persist("historyShell")}
    >
      <ResizablePanel id="history-branches" defaultSize="15%" minSize="12%" maxSize="32%">
        <HistoryBranches />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="history-main" defaultSize="85%" minSize="50%">
        <ResizablePanelGroup
          id="history"
          orientation="vertical"
          className="min-h-0"
          defaultLayout={layouts.current.history}
          onLayoutChanged={persist("history")}
        >
          <ResizablePanel id="history-commits" defaultSize="67%" minSize="28%">
            <HistoryPane />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="history-details" defaultSize="33%" minSize="18%">
            <ResizablePanelGroup
              id="history-details"
              orientation="horizontal"
              className="min-h-0"
              defaultLayout={layouts.current.historyDetails}
              onLayoutChanged={persist("historyDetails")}
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
  const { prefs, updatePanelLayout } = useGit();
  const layouts = useRef(prefs.panelLayouts);

  return (
    <ResizablePanelGroup
      id="changes"
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={layouts.current.changes}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) updatePanelLayout("changes", layout);
      }}
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

export function Workspace() {
  const { view, snapshot } = useGit();
  const [visited, setVisited] = useState({
    history: view === "history",
    stash: view === "stash",
  });

  useEffect(() => {
    setVisited((current) => {
      if (view === "history" && !current.history) return { ...current, history: true };
      if (view === "stash" && !current.stash) return { ...current, stash: true };
      return current;
    });
  }, [view]);

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Opening repository…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {visited.stash ? (
        <div className={cn("min-h-0 flex-1", view === "stash" ? "flex" : "hidden")}>
          <StashPane />
        </div>
      ) : null}
      {visited.history ? (
        <div className={cn("min-h-0 flex-1", view === "history" ? "flex" : "hidden")}>
          <HistoryWorkspace />
        </div>
      ) : null}
      <div className={cn("min-h-0 flex-1", view === "changes" ? "flex" : "hidden")}>
        <ChangesWorkspace />
      </div>
    </div>
  );
}
