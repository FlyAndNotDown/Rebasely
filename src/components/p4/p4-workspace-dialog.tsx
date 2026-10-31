import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/git";
import { useP4 } from "@/state/p4-context";
import type { P4StreamOption } from "@/types/p4";

export function P4WorkspaceDialog() {
  useTranslation();
  const { connection, workspaceOpen, setWorkspaceOpen, saveWorkspace, listStreams } = useP4();
  const [root, setRoot] = useState("");
  const [stream, setStream] = useState("");
  const [streams, setStreams] = useState<P4StreamOption[] | null>(null);
  const [streamQuery, setStreamQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [seed, setSeed] = useState("");
  const nextSeed = workspaceOpen && connection ? `${connection.root}\n${connection.stream ?? ""}` : "";
  if (nextSeed !== seed) {
    setSeed(nextSeed);
    setRoot(connection?.root ?? "");
    setStream(connection?.stream ?? "");
    setStreams(null);
    setStreamQuery("");
    setSaving(false);
  }

  useEffect(() => {
    if (!workspaceOpen) return;
    let live = true;
    void listStreams()
      .then((next) => {
        if (live) setStreams(next);
      })
      .catch((caught) => {
        if (!live) return;
        setStreams([]);
        const message = errorMessage(caught);
        if (message && message !== "Login cancelled") toast.error(message);
      });
    return () => {
      live = false;
    };
  }, [listStreams, workspaceOpen]);

  const needle = streamQuery.trim().toLowerCase();
  const visible = (streams ?? []).filter((item) => item.path.toLowerCase().includes(needle)).slice(0, 80);
  if (
    stream &&
    stream.toLowerCase().includes(needle) &&
    !visible.some((item) => item.path === stream)
  ) {
    visible.unshift({ path: stream, kind: "" });
  }

  async function browse() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("p4.workspaceFolder"),
      defaultPath: root || undefined,
    });
    if (typeof picked === "string") setRoot(picked);
  }

  async function submit() {
    if (!root.trim() || saving) return;
    setSaving(true);
    try {
      await saveWorkspace(root.trim(), stream.trim());
      setWorkspaceOpen(false);
    } catch {
      // The workspace save already reports the error.
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={workspaceOpen} onOpenChange={(open) => !saving && setWorkspaceOpen(open)}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = document.getElementById("edit-p4-root");
          if (!(input instanceof HTMLInputElement)) return;
          const placeCaret = () => {
            if (document.activeElement !== input) return;
            if (input.selectionStart === 0 && input.selectionEnd === input.value.length) {
              const end = input.value.length;
              input.setSelectionRange(end, end);
            }
          };
          // WebView2 selects the whole field when a dialog focuses it.
          placeCaret();
          requestAnimationFrame(placeCaret);
          window.setTimeout(placeCaret, 0);
          window.setTimeout(placeCaret, 50);
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("p4.editWorkspace")}</DialogTitle>
          <DialogDescription>{t("p4.workspaceDescription", { client: connection?.client || t("p4.thisClient") })}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="edit-p4-root">{t("p4.folder")}</Label>
            <div className="flex gap-2">
              <Input
                id="edit-p4-root"
                className="font-mono"
                value={root}
                spellCheck={false}
                onChange={(event) => setRoot(event.target.value)}
              />
              <Button type="button" variant="outline" disabled={saving} onClick={() => void browse()}>{t("p4.browse")}</Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>{t("p4.stream")}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  className="w-full justify-between px-2 font-normal"
                >
                  <span className="min-w-0 truncate font-mono text-xs">{stream || t("p4.classicClient")}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
                <div
                  className="px-1.5 pb-1.5"
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Input
                    value={streamQuery}
                    onChange={(event) => setStreamQuery(event.target.value)}
                    placeholder={streams ? t("p4.filterStreams") : t("p4.loadingStreams")}
                    className="h-7 font-mono"
                    spellCheck={false}
                  />
                </div>
                <div className="max-h-64 overflow-auto">
                  {!needle ? (
                    <DropdownMenuItem onClick={() => setStream("")}>
                      <span className="min-w-4">{stream === "" ? <CheckIcon className="size-3.5" /> : null}</span>{t("p4.classicClient")}</DropdownMenuItem>
                  ) : null}
                  {streams === null ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t("p4.loadingStreams")}</p>
                  ) : visible.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t("p4.noMatchingStreams")}</p>
                  ) : (
                    visible.map((item) => (
                      <DropdownMenuItem key={item.path} onClick={() => setStream(item.path)}>
                        <span className="min-w-4">{stream === item.path ? <CheckIcon className="size-3.5" /> : null}</span>
                        <span className="min-w-0 truncate font-mono">{item.path}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => setWorkspaceOpen(false)}>{t("p4.cancel")}</Button>
          <Button type="button" disabled={saving || !root.trim()} onClick={() => void submit()}>
            {saving ? <Loader2Icon className="animate-spin" /> : null}{t("p4.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
