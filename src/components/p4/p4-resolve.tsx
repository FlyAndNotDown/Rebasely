import { useEffect, useState } from "react";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/git";
import { depotBase } from "@/lib/p4";
import { useP4 } from "@/state/p4-context";
import type { P4ResolveView } from "@/types/p4";

export function P4Resolve({
  path,
  onResolved,
}: {
  path: string;
  onResolved: () => void;
}) {
  const { resolveView, resolveAccept } = useP4();
  const [view, setView] = useState<P4ResolveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"yours" | "theirs" | "merge" | null>(null);
  const loading = view === null && error === null;

  useEffect(() => {
    let cancelled = false;
    void resolveView(path)
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setError("This file does not need resolve.");
          return;
        }
        setView(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught) || "Could not open this resolve");
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolveView]);

  async function accept(mode: "yours" | "theirs" | "merge") {
    setBusy(mode);
    const ok = await resolveAccept(path, mode);
    setBusy(null);
    if (ok) onResolved();
  }

  const content = view?.content ?? false;
  const name = depotBase(view?.path || path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b px-3">
        <span className="min-w-0 truncate font-mono text-sm" title={view?.path || path}>
          {name}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={view?.summary}>
          {loading ? "Loading resolve" : (view?.summary ?? "Needs resolve")}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || busy !== null}
            onClick={() => void accept("yours")}
          >
            Accept yours
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || busy !== null}
            onClick={() => void accept("theirs")}
          >
            Accept theirs
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || busy !== null || Boolean(error) || !content}
            onClick={() => void accept("merge")}
          >
            Merge
          </Button>
        </div>
      </div>
      {error ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-destructive">
          {error}
        </div>
      ) : view?.comparable ? (
        <P4Diff
          diff={view.diff}
          loading={false}
          empty="Yours and theirs have the same text."
          split
          captions={["Yours", "Theirs"]}
          chrome={false}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {loading ? "Loading resolve" : "The two sides can't be compared here."}
        </div>
      )}
    </div>
  );
}
