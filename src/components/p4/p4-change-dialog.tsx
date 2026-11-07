import { useId, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { ChangeBadge } from "@/components/p4/change-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";

export type ChangeDialogRequest = { id: string; description: string; mode: "edit" | "submit" };

export function P4ChangeDialog({
  request,
  openedCount,
  available,
  busy,
  onConfirm,
  onClose,
}: {
  request: ChangeDialogRequest;
  openedCount: number;
  available: boolean;
  busy: boolean;
  onConfirm: (description: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const [description, setDescription] = useState(request.description);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const submitting = request.mode === "submit";
  const blocked = busy || working;
  const canConfirm = available && (!submitting || openedCount > 0) && !!description.trim();

  async function confirm() {
    if (blocked || running.current || !canConfirm) return;
    running.current = true;
    setWorking(true);
    setFailed(false);
    try {
      if (await onConfirm(description)) onClose();
      else setFailed(true);
    } finally {
      running.current = false;
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running.current && onClose()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!working}>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
          <DialogHeader>
            <DialogTitle>{t(submitting ? "p4.changeDialog.submitTitle" : "p4.changeDialog.editTitle")}</DialogTitle>
            <DialogDescription>
              {t(submitting ? "p4.changeDialog.submitDescription" : request.id === "default" ? "p4.changeDialog.defaultDescription" : "p4.changeDialog.editDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ChangeBadge id={request.id} />
            <span>{t("p4.changeDialog.openedFiles", { count: openedCount })}</span>
          </div>
          <div className="grid gap-2">
            <label htmlFor={descriptionId} className="text-sm font-medium">{t("p4.description")}</label>
            <Textarea
              id={descriptionId}
              autoFocus
              className="min-h-32 max-h-64"
              value={description}
              disabled={blocked}
              onChange={(event) => { setDescription(event.target.value); setFailed(false); }}
            />
          </div>
          {!available ? <p role="alert" className="text-sm text-destructive">{t("p4.changeDialog.unavailable")}</p> : null}
          {failed ? <p role="alert" className="text-sm text-destructive">{t("p4.changeDialog.failed")}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={onClose}>{t("p4.cancel")}</Button>
            <Button type="submit" disabled={blocked || !canConfirm}>
              {working ? <Loader2Icon className="animate-spin" /> : null}
              {t(working ? submitting ? "p4.submitting" : "p4.savingChangelist" : submitting ? "p4.submitChangelist" : "p4.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
