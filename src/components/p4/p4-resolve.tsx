import { t, useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { GitMergeIcon, LoaderCircleIcon } from "lucide-react";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { depotBase } from "@/lib/p4";
import { p4DisplayText } from "@/lib/p4-display";
import { useP4 } from "@/state/p4-context";
import type { P4ResolveView } from "@/types/p4";

type ResolveMode = "yours" | "theirs" | "merge";

const choices = [
  { mode: "merge", get label() { return t("p4.autoMerge"); }, get tip() { return t("p4.autoMergeHint"); } },
  { mode: "yours", get label() { return t("p4.acceptYours"); }, get tip() { return t("p4.acceptYoursHint"); } },
  { mode: "theirs", get label() { return t("p4.acceptTheirs"); }, get tip() { return t("p4.acceptTheirsHint"); } },
] as const;

export function P4Resolve({ path, onClose }: { path: string; onClose: () => void }) {
  useTranslation();
  const { resolveView, resolveAccept, busy: workspaceBusy } = useP4();
  const [view, setView] = useState<P4ResolveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<ResolveMode | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const loading = view === null && error === null;

  useEffect(() => {
    let live = true;
    void resolveView(path)
      .then((next) => {
        if (!live) return;
        if (next) setView(next);
        else setError(t("p4.thisFileDoesNotNeedResolve"));
      })
      .catch((caught: unknown) => {
        if (live) setError(p4DisplayText(errorMessage(caught)) || t("p4.couldNotOpenThisResolve"));
      });
    return () => { live = false; };
  }, [attempt, path, resolveView]);

  async function accept() {
    if (!view || !mode || workspaceBusy || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      if (await resolveAccept(path, mode)) onClose();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running.current && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("p4.resolveFile", { file: depotBase(path) })}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={path}>{path}</DialogDescription>
        </DialogHeader>
        {view?.summary ? <p className="truncate text-xs text-muted-foreground" title={p4DisplayText(view.summary)}>{p4DisplayText(view.summary)}</p> : null}
        <div className="relative flex h-[min(42vh,24rem)] min-h-24 min-w-0 flex-col overflow-hidden rounded-lg border">
          {error ? (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-destructive">
              {error}
              <Button variant="outline" size="sm" onClick={() => { setError(null); setAttempt((current) => current + 1); }}>{t("common.retry")}</Button>
            </div>
          ) : (
            <P4Diff
              diff={view?.comparable ? view.diff : null}
              loading={loading}
              empty={view?.comparable ? t("p4.noTextDifferences") : t("p4.theTwoSidesCantBeComparedHere")}
              split
              captions={view?.workingCopy
                ? [t("p4.incomingRevision"), t("p4.workspaceFile")]
                : [t("p4.syncedRevision"), t("p4.incomingRevision")]}
              chrome={false}
            />
          )}
        </div>
        {view && view.pendingResolves > 1 ? (
          <p className="text-xs text-muted-foreground">{t("p4.multipleResolves", { count: view.pendingResolves })}</p>
        ) : null}
        <fieldset className="flex flex-wrap gap-2" disabled={!view || busy || workspaceBusy}>
          <legend className="sr-only">{t("p4.resolve")}</legend>
          {choices.map((choice) => choice.mode !== "merge" || view?.content ? (
            <HoverTip key={choice.mode} label={choice.tip}>
              <label className="flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm has-checked:border-foreground/50 has-checked:bg-muted has-disabled:opacity-50">
                <input type="radio" name="p4-resolve-mode" className="size-3.5 accent-foreground" checked={mode === choice.mode} onChange={() => setMode(choice.mode)} />
                {choice.label}
              </label>
            </HoverTip>
          ) : null)}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={!view || !mode || busy || workspaceBusy} onClick={() => void accept()}>
            {busy ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <GitMergeIcon />}
            {t("p4.resolve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
