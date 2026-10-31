import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/git";
import { depotBase } from "@/lib/p4";
import { p4DisplayText } from "@/lib/p4-display";
import { useP4 } from "@/state/p4-context";
import type { P4ResolveView } from "@/types/p4";

export function P4Resolve({
  path,
  onResolved,
}: {
  path: string;
  onResolved: () => void;
}) {
  useTranslation();
  const { resolveView, resolveAccept, busy: workspaceBusy } = useP4();
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
          setError(t("p4.thisFileDoesNotNeedResolve"));
          return;
        }
        setView(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught) || t("p4.couldNotOpenThisResolve"));
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolveView]);

  async function accept(mode: "yours" | "theirs" | "merge") {
    if (busy || workspaceBusy) return;
    setBusy(mode);
    const ok = await resolveAccept(path, mode);
    setBusy(null);
    if (ok) onResolved();
  }

  const content = view?.content ?? false;
  const name = depotBase(view?.path || path);

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b px-3">
        <span className="min-w-0 truncate font-mono text-sm" title={view?.path || path}>
          {name}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <p role={loading ? "status" : undefined} className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={view ? p4DisplayText(view.summary) : undefined}>
          {loading ? t("p4.loadingResolve") : p4DisplayText(view?.summary ?? "Needs resolve")}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || busy !== null || workspaceBusy}
            onClick={() => void accept("yours")}
          >{t("p4.acceptYours")}</Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || busy !== null || workspaceBusy}
            onClick={() => void accept("theirs")}
          >{t("p4.acceptTheirs")}</Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || busy !== null || workspaceBusy || Boolean(error) || !content}
            onClick={() => void accept("merge")}
          >{t("p4.merge")}</Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="flex flex-1 items-center justify-center p-6 text-center text-sm text-destructive">
          {error}
        </div>
      ) : view?.comparable ? (
        <P4Diff
          diff={view.diff}
          loading={false}
          empty={t("p4.yoursAndTheirsHaveTheSameText")}
          split
          captions={[t("p4.yours"), t("p4.theirs")]}
          chrome={false}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {loading ? t("p4.loadingResolve") : t("p4.theTwoSidesCantBeComparedHere")}
        </div>
      )}
    </div>
  );
}
