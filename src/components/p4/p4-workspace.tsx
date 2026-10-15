import { P4Files } from "@/components/p4/p4-files";
import { P4Pending } from "@/components/p4/p4-pending";
import { P4Submitted } from "@/components/p4/p4-submitted";
import { Button } from "@/components/ui/button";
import { useP4 } from "@/state/p4-context";

export function P4Workspace() {
  const { view, loading, error, connection, reconnect } = useP4();

  if (!connection) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm text-muted-foreground">
            {loading ? "Connecting to Perforce…" : error || "This workspace is not connected."}
          </p>
          {!loading ? (
            <Button type="button" className="mt-4" onClick={reconnect}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {view === "submitted" ? <P4Submitted /> : view === "workspace" ? <P4Files /> : <P4Pending />}
    </div>
  );
}
