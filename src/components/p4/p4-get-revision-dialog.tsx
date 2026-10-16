import { useState } from "react";
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
import { relativeToRoot } from "@/lib/p4";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4RevisionMode } from "@/types/p4";

const KINDS: { id: Exclude<P4RevisionMode, "latest">; label: string; placeholder: string }[] = [
  { id: "revision", label: "Revision", placeholder: "Enter revision number" },
  { id: "changelist", label: "Changelist", placeholder: "Enter changelist number" },
  { id: "datetime", label: "Date/Time", placeholder: "yyyy/mm/dd:hh:mm:ss" },
  { id: "label", label: "Label", placeholder: "Enter label" },
  { id: "workspace", label: "Workspace", placeholder: "Enter workspace" },
];

export function P4GetRevisionDialog({
  path,
  onOpenChange,
}: {
  path: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { connection, getRevision } = useP4();
  const [seen, setSeen] = useState<string | null>(null);
  const [latest, setLatest] = useState(true);
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("revision");
  const [value, setValue] = useState("");
  const [force, setForce] = useState(false);
  const [safe, setSafe] = useState(false);
  const [filesOnly, setFilesOnly] = useState(false);
  const [removeMissing, setRemoveMissing] = useState(true);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState<"preview" | "sync" | null>(null);
  if (path !== seen) {
    setSeen(path);
    setLatest(true);
    setKind("revision");
    setValue("");
    setForce(false);
    setSafe(false);
    setFilesOnly(false);
    setRemoveMissing(true);
    setPreview("");
    setBusy(null);
  }

  const specify = !latest;
  const placeholder = KINDS.find((item) => item.id === kind)?.placeholder ?? "";
  const needsValue = specify && !value.trim();
  const relative = path && connection ? relativeToRoot(connection.root, path) || path : "";

  async function run(previewing: boolean) {
    if (!path || busy || needsValue) return;
    setBusy(previewing ? "preview" : "sync");
    try {
      const output = await getRevision({
        paths: [path],
        mode: specify ? kind : "latest",
        value: specify ? value.trim() : "",
        force,
        safe,
        changelistFilesOnly: specify && kind === "changelist" && filesOnly,
        removeNotInLabel: !specify || kind !== "label" || removeMissing,
        preview: previewing,
      });
      if (previewing) {
        setPreview(output.trim() || "Up to date.");
      } else {
        onOpenChange(false);
      }
    } catch {
      // The revision request already reports the error.
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Get revision</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={relative}>
            {relative}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="get-revision-mode"
              className="size-3.5 accent-foreground"
              checked={latest}
              disabled={busy !== null}
              onChange={() => {
                setLatest(true);
                setPreview("");
              }}
            />
            Get latest revision
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="get-revision-mode"
                className="size-3.5 accent-foreground"
                checked={specify}
                disabled={busy !== null}
                onChange={() => {
                  setLatest(false);
                  setPreview("");
                }}
              />
              Specify revision using
            </label>
            <select
              aria-label="Revision type"
              value={kind}
              disabled={!specify || busy !== null}
              onChange={(event) => {
                setKind(event.target.value as (typeof KINDS)[number]["id"]);
                setValue("");
                setPreview("");
              }}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm disabled:opacity-50 dark:bg-input/30"
            >
              {KINDS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <Input
              value={value}
              disabled={!specify || busy !== null}
              placeholder={placeholder}
              spellCheck={false}
              className="min-w-40 flex-1 font-mono"
              onChange={(event) => {
                setValue(event.target.value);
                setPreview("");
              }}
            />
          </div>
          <div className="grid gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">Options</p>
            <Option
              checked={force}
              disabled={busy !== null}
              onCheckedChange={setForce}
              label="Force operation (replace the file even if you already have that revision)"
            />
            <Option
              checked={safe}
              disabled={busy !== null}
              onCheckedChange={setSafe}
              label="Safe update (don't overwrite files changed without being checked out)"
            />
            <Option
              checked={filesOnly}
              disabled={busy !== null || !specify || kind !== "changelist"}
              onCheckedChange={setFilesOnly}
              label="Only get revisions for files listed in the changelist"
            />
            <Option
              checked={removeMissing}
              disabled={busy !== null || !specify || kind !== "label"}
              onCheckedChange={setRemoveMissing}
              label="Remove files from the workspace if they are not in the label"
            />
          </div>
          {preview ? (
            <pre className="max-h-36 overflow-auto rounded-lg border bg-background/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {preview}
            </pre>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="outline" disabled={busy !== null || needsValue} onClick={() => void run(true)}>
            {busy === "preview" ? <Loader2Icon className="animate-spin" /> : null}
            Preview
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy !== null || needsValue} onClick={() => void run(false)}>
              {busy === "sync" ? <Loader2Icon className="animate-spin" /> : null}
              Get revision
            </Button>
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
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className={cn("flex items-start gap-2 text-xs leading-snug", disabled && "opacity-50")}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        className="mt-0.5"
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span>{label}</span>
    </label>
  );
}
