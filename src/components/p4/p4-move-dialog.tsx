import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { relativeToRoot } from "@/lib/p4";
import { useP4 } from "@/state/p4-context";

export function P4MoveDialog({ source, onMoved, onClose }: { source: string; onMoved: (destination: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const p4 = useP4();
  const relative = relativeToRoot(p4.connection?.root ?? "", source);
  const [destination, setDestination] = useState(relative);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const blocked = busy || p4.busy;
  async function move() {
    if (blocked || !destination.trim() || destination === relative) return;
    setBusy(true);
    setFailed(false);
    try {
      if (await p4.renameFile(source, destination)) { onMoved(destination); onClose(); }
      else setFailed(true);
    } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void move(); }}>
        <DialogHeader>
          <DialogTitle>{t("p4.move.title")}</DialogTitle>
          <DialogDescription>{t("p4.move.description")}</DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{relative}</p>
        <label className="grid gap-2 text-sm">
          {t("p4.move.destination")}
          <Input value={destination} onChange={(event) => { setDestination(event.target.value); setFailed(false); }} disabled={blocked} autoFocus spellCheck={false} />
        </label>
        <p className="text-xs text-muted-foreground">{t("p4.move.hint")}</p>
        {failed ? <p role="alert" className="text-sm text-destructive">{t("p4.move.failed")}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={blocked || !destination.trim() || destination === relative}>
            {busy ? <Loader2Icon className="animate-spin" /> : null}{t(busy ? "p4.move.moving" : "p4.move.action")}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
