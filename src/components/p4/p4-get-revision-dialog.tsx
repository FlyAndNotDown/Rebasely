import { t, useTranslation } from "@/i18n";
import { useId, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/tooltip";
import { relativeToRoot } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4RevisionMode } from "@/types/p4";

export type P4RevisionTarget = { path: string; recursive: boolean } | { changeId: string; revision?: string };

export function P4GetRevisionDialog({ target, onClose }: { target: P4RevisionTarget; onClose: () => void }) {
  useTranslation();
  const group = useId();
  const kinds: { id: Exclude<P4RevisionMode, "latest">; label: string; placeholder: string }[] = [
    { id: "revision", label: t("p4.revision"), placeholder: t("p4.enterRevisionNumber") },
    { id: "changelist", label: t("p4.changelist"), placeholder: t("p4.enterChangelistNumber") },
    { id: "datetime", label: t("p4.dateTime"), placeholder: "yyyy/mm/dd:hh:mm:ss" },
    { id: "label", label: t("p4.label"), placeholder: t("p4.enterLabel") },
    { id: "workspace", label: t("p4.workspace"), placeholder: t("p4.enterWorkspace") },
  ];
  const { connection, getRevision, busy: workspaceBusy } = useP4();
  const path = "path" in target ? target.path : null;
  const recursive = "recursive" in target && target.recursive;
  const changeId = "changeId" in target ? target.changeId : undefined;
  const revision = "revision" in target ? target.revision : undefined;
  const [latest, setLatest] = useState(path !== null);
  const [kind, setKind] = useState<(typeof kinds)[number]["id"]>(revision ? "changelist" : "revision");
  const [value, setValue] = useState(revision ?? "");
  const [force, setForce] = useState(false);
  const [safe, setSafe] = useState(false);
  const [filesOnly, setFilesOnly] = useState(false);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState<"preview" | "sync" | null>(null);
  const running = useRef(false);

  const specify = !latest;
  const placeholder = kinds.find((item) => item.id === kind)?.placeholder ?? "";
  const needsValue = specify && !value.trim();
  const blocked = busy !== null || workspaceBusy;
  const relative = path && connection ? relativeToRoot(connection.root, path) || path : path;
  const scope = changeId ? t("p4.revisionChangeScope", { id: changeId })
    : recursive ? t("p4.revisionDirectoryScope", { path: relative }) : relative;

  async function run(previewing: boolean) {
    if (running.current || blocked || needsValue) return;
    running.current = true;
    setPreview("");
    setBusy(previewing ? "preview" : "sync");
    try {
      const output = await getRevision({
        paths: path ? [path] : [],
        changeId,
        recursive,
        mode: specify ? kind : "latest",
        value: specify ? value.trim() : "",
        force,
        safe,
        changelistFilesOnly: specify && kind === "changelist" && filesOnly,
        removeNotInLabel: !specify || kind !== "label" || removeMissing,
        preview: previewing,
      });
      if (output === null) return;
      if (previewing) {
        setPreview(output.trim() || t("p4.upToDate"));
      } else {
        onClose();
      }
    } catch {
      // The revision request already reports the error.
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running.current && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("p4.getRevision")}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={scope ?? undefined}>
            {scope}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={group}
              className="size-3.5 accent-foreground"
              checked={latest}
              disabled={blocked}
              onChange={() => {
                setLatest(true);
                setPreview("");
              }}
            />{t("p4.getLatestRevision")}</label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={group}
                className="size-3.5 accent-foreground"
                checked={specify}
                disabled={blocked}
                onChange={() => {
                  setLatest(false);
                  setPreview("");
                }}
              />{t("p4.specifyRevisionUsing")}</label>
            <select
              aria-label={t("p4.revisionType")}
              value={kind}
              disabled={!specify || blocked}
              onChange={(event) => {
                setKind(event.target.value as (typeof kinds)[number]["id"]);
                setValue("");
                setPreview("");
              }}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm disabled:opacity-50 dark:bg-input/30"
            >
              {kinds.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <Input
              value={value}
              disabled={!specify || blocked}
              placeholder={placeholder}
              aria-label={placeholder}
              spellCheck={false}
              className="min-w-40 flex-1 font-mono"
              onChange={(event) => {
                setValue(event.target.value);
                setPreview("");
              }}
            />
          </div>
          <div className="grid gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">{t("p4.options")}</p>
            <Option
              checked={force}
              disabled={blocked}
              onCheckedChange={(checked) => { setForce(checked); if (checked) setSafe(false); setPreview(""); }}
              label={t("p4.forceOverwrite")}
              tip={t("p4.replaceTheFileEvenWhenYouAlreadyHaveThatRevision")}
            />
            <Option
              checked={safe}
              disabled={blocked}
              onCheckedChange={(checked) => { setSafe(checked); if (checked) setForce(false); setPreview(""); }}
              label={t("p4.safeUpdate")}
              tip={t("p4.keepFilesChangedWithoutBeingCheckedOut")}
            />
            <Option
              checked={filesOnly}
              disabled={blocked || !specify || kind !== "changelist"}
              onCheckedChange={(checked) => { setFilesOnly(checked); setPreview(""); }}
              label={t("p4.changelistFilesOnly")}
              tip={t("p4.getRevisionsOnlyForFilesListedInThisChangelist")}
            />
            <Option
              checked={removeMissing}
              disabled={blocked || !specify || kind !== "label"}
              onCheckedChange={(checked) => { setRemoveMissing(checked); setPreview(""); }}
              label={t("p4.removeFilesMissingFromLabel")}
              tip={t("p4.removeWorkspaceFilesThatAreAbsentFromThisLabel")}
            />
          </div>
          {preview ? (
            <pre role="status" tabIndex={0} className="max-h-36 overflow-auto rounded-lg border bg-background/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {preview}
            </pre>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="outline" disabled={blocked || needsValue} onClick={() => void run(true)}>
            {busy === "preview" ? <Loader2Icon className="animate-spin" /> : null}{t("p4.preview")}</Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={onClose}>{t("p4.cancel")}</Button>
            <Button type="button" disabled={blocked || needsValue} onClick={() => void run(false)}>
              {busy === "sync" ? <Loader2Icon className="animate-spin" /> : null}{t("p4.getRevision")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  checked,
  disabled,
  onCheckedChange,
  label,
  tip,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  tip: string;
}) {
  useTranslation();
  return (
    <label className={cn("flex items-start gap-2 text-xs leading-snug", disabled && "opacity-50")}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        className="mt-0.5"
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <HoverTip label={tip}><span>{label}</span></HoverTip>
    </label>
  );
}
