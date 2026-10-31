import { lazy, Suspense } from "react";
import { WorkspaceSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { useGitPick } from "@/state/git-context";
import { useP4 } from "@/state/p4-context";

const P4Files = lazy(() => import("@/components/p4/p4-files").then((module) => ({ default: module.P4Files })));
const P4Pending = lazy(() => import("@/components/p4/p4-pending").then((module) => ({ default: module.P4Pending })));
const P4Submitted = lazy(() => import("@/components/p4/p4-submitted").then((module) => ({ default: module.P4Submitted })));

export function P4Workspace() {
  const { view, loading, error, connection, reconnect } = useP4();
  const { setOpenPanel } = useGitPick(["setOpenPanel"]);

  if (!connection) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p role={loading ? "status" : error ? "alert" : undefined} className="text-sm text-muted-foreground">
            {loading ? "Connecting to Perforce…" : error || "This workspace is not connected."}
          </p>
          {!loading ? (
            <div className="mt-4 flex justify-center gap-2">
              {error ? (
                <Button onClick={() => setOpenPanel("settings")}>Settings</Button>
              ) : null}
              <Button variant={error ? "outline" : "default"} onClick={reconnect}>Try again</Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense fallback={<WorkspaceSkeleton />}>
        {view === "submitted" ? <P4Submitted /> : view === "workspace" ? <P4Files /> : <P4Pending />}
      </Suspense>
    </div>
  );
}
