import { useEffect, useId, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckIcon, ChevronDownIcon, FolderOpenIcon, Loader2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { errorMessage } from "@/lib/git";
import { P4_MISSING } from "@/lib/p4";
import { createP4PreviewGate, p4OperationErrorKey, p4OperationKey, type P4OperationKind } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4IntegrateRequest, P4OperationPreview, P4UndoRequest, P4UndoSelector } from "@/types/p4";

export function P4OperationDialog({ operation, path, depot, onClose }: {
  operation: P4OperationKind;
  path: string;
  depot: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const p4 = useP4();
  const id = useId();
  const [source, setSource] = useState(depot ? path : "");
  const [target, setTarget] = useState(depot ? "" : path);
  const [limited, setLimited] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<P4UndoSelector["mode"]>("revision");
  const [revision, setRevision] = useState("");
  const [submittedChange, setSubmittedChange] = useState("");
  const [changeId, setChangeId] = useState(p4.selectedChange);
  const [preview, setPreview] = useState<{ key: string; value: P4OperationPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"browse" | "preview" | "apply" | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const [gate] = useState(createP4PreviewGate);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; gate.invalidate(); };
  }, [gate]);

  const selector: P4UndoSelector = mode === "revision" ? { mode, revision: revision.trim() }
    : mode === "range" ? { mode, from: from.trim(), to: to.trim() }
      : { mode, change: submittedChange.trim() };
  const integrateRequest: P4IntegrateRequest = { source, target, range: limited ? { from: from.trim(), to: to.trim() } : null, changeId };
  const undoRequest: P4UndoRequest = { path: target, selector, changeId };
  const connection = p4.connection;
  const key = connection ? p4OperationKey(operation, connection, operation === "integrate" ? integrateRequest : undoRequest) : "";
  const positive = (value: string) => /^[1-9]\d*$/.test(value.trim());
  const validRange = positive(from) && positive(to) && BigInt(from.trim()) <= BigInt(to.trim());
  const streamUnsupported = operation === "integrate" && Boolean(connection?.stream);
  const valid = !streamUnsupported && Boolean(connection && target.trim()) && (operation === "integrate"
    ? source.startsWith("//") && (!limited || validRange)
    : mode === "revision" ? positive(revision) : mode === "range" ? validRange : positive(submittedChange));
  const blocked = busy !== null || p4.busy;
  const approved = preview?.key === key && gate.accepts(key, preview.value.fingerprint);
  const choices = [...new Set(["default", ...p4.pending.filter((change) => change.id !== "default" && change.user === connection?.user && change.client === connection.client).map((change) => change.id)])];
  const availableChange = choices.includes(changeId);
  const changeLabel = changeId === "default" ? t("p4-operations.defaultChange") : changeId;

  function edit(update: () => void) {
    gate.invalidate();
    setPreview(null);
    setError(null);
    update();
  }

  function close() {
    if (busy === "apply") return;
    gate.invalidate();
    onClose();
  }

  function fail(caught: unknown) {
    const message = errorMessage(caught);
    const errorKey = p4OperationErrorKey(message);
    setError(errorKey ? t(errorKey) : message === P4_MISSING ? t("desktop.dependencies.p4Missing") : message === "Login cancelled" ? t("p4-operations.cancelled") : message);
  }

  async function browse() {
    if (running.current || blocked) return;
    running.current = true;
    setBusy("browse");
    try {
      const selected = await save({ title: t("p4-operations.chooseTarget"), defaultPath: target || connection?.root });
      if (selected && mounted.current) edit(() => setTarget(selected));
    } catch (caught) { if (mounted.current) fail(caught); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  async function showPreview() {
    if (running.current || blocked || !valid || !availableChange) return;
    running.current = true;
    setBusy("preview");
    setError(null);
    setPreview(null);
    const request = gate.begin(key);
    try {
      const value = operation === "integrate" ? await p4.previewIntegrate(integrateRequest) : await p4.previewUndo(undoRequest);
      if (gate.complete(request, value.fingerprint) && mounted.current) setPreview({ key, value });
    } catch (caught) { if (mounted.current) fail(caught); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  async function apply() {
    if (running.current || blocked || !valid || !approved || !preview || !availableChange) return;
    running.current = true;
    setBusy("apply");
    setError(null);
    gate.invalidate();
    try {
      if (operation === "integrate") await p4.applyIntegrate(integrateRequest, preview.value);
      else await p4.applyUndo(undoRequest, preview.value);
      onClose();
    } catch (caught) { if (mounted.current) fail(caught); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  const undoScope = mode === "revision" ? t("p4-operations.undo.revisionScope", { revision })
    : mode === "range" ? t("p4-operations.undo.rangeScope", { from, to })
      : t("p4-operations.undo.changeScope", { change: submittedChange });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="flex max-h-[calc(100vh-3rem)] flex-col sm:max-w-2xl" showCloseButton={busy !== "apply"} onOpenAutoFocus={(event) => {
        const input = document.getElementById(`${id}-${operation === "integrate" ? "source" : "revision"}`);
        if (input instanceof HTMLInputElement) { event.preventDefault(); input.focus(); }
      }}>
        <DialogHeader>
          <DialogTitle>{t(operation === "integrate" ? "p4-operations.integrate.title" : "p4-operations.undo.title")}</DialogTitle>
          <DialogDescription>{t(operation === "integrate" ? "p4-operations.integrate.description" : "p4-operations.undo.description")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-[min(32rem,65vh)]" scrollbars="vertical">
          <div className="grid gap-4 pr-3 pb-2">
            {streamUnsupported ? <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">{t("p4-operations.integrate.streamUnsupported")}</p> : null}
            {operation === "integrate" ? <div className="grid gap-2">
              <Label htmlFor={`${id}-source`}>{t("p4-operations.integrate.source")}</Label>
              <Input id={`${id}-source`} value={source} disabled={blocked} onChange={(event) => edit(() => setSource(event.target.value))} className="font-mono text-xs" placeholder="//depot/main/file.txt" spellCheck={false} autoFocus />
              <p className="text-xs text-muted-foreground">{t("p4-operations.integrate.sourceHint")}</p>
            </div> : null}
            <div className="grid gap-2">
              <Label htmlFor={`${id}-target`}>{t(operation === "integrate" ? "p4-operations.integrate.target" : "p4-operations.undo.target")}</Label>
              <div className="flex gap-2">
                <Input id={`${id}-target`} value={target} readOnly={operation === "undo"} disabled={blocked} onChange={(event) => edit(() => setTarget(event.target.value))} className="min-w-0 font-mono text-xs" placeholder={t("p4-operations.absoluteTarget")} spellCheck={false} />
                {operation === "integrate" ? <Button variant="outline" disabled={blocked} onClick={() => void browse()}><FolderOpenIcon />{t("p4-operations.browse")}</Button> : null}
              </div>
            </div>
            {operation === "integrate" ? <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={limited} disabled={blocked} onCheckedChange={(checked) => edit(() => setLimited(checked === true))} />{t("p4-operations.integrate.limitRevisions")}
            </label> : <div className="grid gap-2">
              <Label>{t("p4-operations.undo.selector")}</Label>
              <SegmentedControl label={t("p4-operations.undo.selector")} value={mode} disabled={blocked} onChange={(value) => edit(() => setMode(value))} options={[
                { value: "revision", label: t("p4-operations.undo.revision") },
                { value: "range", label: t("p4-operations.undo.range") },
                { value: "changelist", label: t("p4-operations.undo.changelist") },
              ]} />
            </div>}
            {(operation === "integrate" && limited) || (operation === "undo" && mode === "range") ? <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2"><Label htmlFor={`${id}-from`}>{t("p4-operations.fromRevision")}</Label><Input id={`${id}-from`} value={from} disabled={blocked} inputMode="numeric" maxLength={20} onChange={(event) => edit(() => setFrom(event.target.value))} /></div>
              <div className="grid gap-2"><Label htmlFor={`${id}-to`}>{t("p4-operations.toRevision")}</Label><Input id={`${id}-to`} value={to} disabled={blocked} inputMode="numeric" maxLength={20} onChange={(event) => edit(() => setTo(event.target.value))} /></div>
            </div> : operation === "undo" ? <div className="grid gap-2">
              <Label htmlFor={`${id}-revision`}>{t(mode === "revision" ? "p4-operations.undo.revisionNumber" : "p4-operations.undo.changeNumber")}</Label>
              <Input id={`${id}-revision`} value={mode === "revision" ? revision : submittedChange} disabled={blocked} inputMode="numeric" maxLength={20} onChange={(event) => edit(() => mode === "revision" ? setRevision(event.target.value) : setSubmittedChange(event.target.value))} autoFocus />
            </div> : null}
            <div className="grid gap-2">
              <Label>{t("p4-operations.pendingChange")}</Label>
              <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" disabled={blocked} className="justify-between" aria-label={t("p4-operations.pendingChange")}><span>{changeLabel}</span><ChevronDownIcon /></Button></DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-60 min-w-48">{choices.map((choice) => <DropdownMenuItem key={choice} onClick={() => edit(() => setChangeId(choice))}><span className="min-w-4">{choice === changeId ? <CheckIcon className="size-3.5" /> : null}</span>{choice === "default" ? t("p4-operations.defaultChange") : choice}</DropdownMenuItem>)}</DropdownMenuContent>
              </DropdownMenu>
              {!availableChange ? <p role="alert" className="text-xs text-destructive">{t("p4-operations.changeUnavailable")}</p> : null}
            </div>
            <div className="grid gap-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t("p4-operations.previewTitle")}</p>
              {preview ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{preview.value.output || t("p4-operations.noChanges")}</pre> : <p role="status" className="text-xs text-muted-foreground">{t(busy === "preview" ? "p4-operations.previewing" : "p4-operations.previewRequired")}</p>}
              {preview && !approved && busy !== "apply" ? <p role="status" className="text-xs text-muted-foreground">{t("p4-operations.previewAgain")}</p> : null}
            </div>
            {error ? <div role="alert" className="grid gap-1 rounded-md border border-destructive/30 p-3 text-xs text-destructive"><p>{t("p4-operations.failed")}</p><p className="whitespace-pre-wrap break-all">{error}</p></div> : null}
          </div>
        </ScrollArea>
        <DialogFooter className="mt-2">
          <p className="mr-auto min-w-0 flex-1 self-center break-all text-xs text-muted-foreground">{operation === "undo" ? t("p4-operations.undo.confirm", { target, scope: undoScope, change: changeLabel }) : t("p4-operations.integrate.confirm", { target, change: changeLabel })}</p>
          <Button variant="outline" disabled={busy === "apply"} onClick={close}>{t("common.cancel")}</Button>
          <Button variant="outline" disabled={blocked || !valid || !availableChange} onClick={() => void showPreview()}>{busy === "preview" ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("p4-operations.preview")}</Button>
          <Button variant={operation === "undo" ? "destructive" : "default"} disabled={blocked || !valid || !approved || !availableChange} onClick={() => void apply()}>{busy === "apply" ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t(operation === "integrate" ? "p4-operations.integrate.action" : "p4-operations.undo.action")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
