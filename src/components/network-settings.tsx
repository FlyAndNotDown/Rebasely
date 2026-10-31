import { useId, useRef, useState } from "react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { normalizeHttpProxy, proxyValidationError, type HttpProxy } from "@/lib/network";

const modes: { id: HttpProxy["mode"]; label: string }[] = [
  { id: "system", label: "System proxy" },
  { id: "none", label: "No proxy" },
  { id: "manual", label: "Manual proxy" },
];

export function NetworkSettings({ value, onSave }: { value: HttpProxy; onSave: (proxy: HttpProxy) => Promise<boolean> }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  const next = normalizeHttpProxy(draft);
  const changed = next.mode !== value.mode || next.url.trim() !== value.url;

  function edit(patch: Partial<HttpProxy>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
    setSaved(false);
  }

  async function apply() {
    if (busy.current) return;
    const validation = proxyValidationError(next);
    if (validation) { setError(validation); return; }
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const submitted = { ...next, url: next.mode === "manual" ? new URL(next.url.trim()).toString() : "" };
      if (await onSave(submitted)) { setDraft(submitted); setSaved(true); }
      else setError("Could not save the proxy. Your entries are preserved; try again.");
    } catch {
      setError("Could not save the proxy. Your entries are preserved; try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3">
      <div className="flex items-center gap-1.5">
        <h3 id={`${id}-title`} className="text-sm font-medium">Client network</h3>
        <HoverTip label="Applies to application HTTP requests. Git and Perforce use their own settings. System uses static HTTP/HTTPS proxies; for PAC or SOCKS-only configurations, choose Manual.">
          <InfoIcon tabIndex={0} aria-label="About client network settings" className="size-3.5 text-muted-foreground" />
        </HoverTip>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label id={`${id}-mode`}>Proxy</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={saving} aria-labelledby={`${id}-mode ${id}-choice`}>
              <span id={`${id}-choice`}>{modes.find((mode) => mode.id === draft.mode)?.label}</span><ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={draft.mode} onValueChange={(value) => {
              if (value === "system" || value === "none" || value === "manual") edit({ mode: value });
            }}>
              {modes.map((mode) => <DropdownMenuRadioItem key={mode.id} value={mode.id} disabled={saving}>{mode.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {draft.mode === "manual" ? (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-url`}>Proxy URL</Label>
          <Input id={`${id}-url`} type="url" autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:8080" value={draft.url} disabled={saving} onChange={(event) => edit({ url: event.target.value })} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          <p className="text-xs text-muted-foreground">HTTP, HTTPS, SOCKS5 or SOCKS5H. Credentials are not accepted.</p>
        </div>
      ) : draft.mode === "system" ? (
        <p className="text-xs text-muted-foreground">Uses operating system proxy settings on Windows and macOS, and proxy environment variables on Linux.</p>
      ) : null}
      {error ? <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={saving || !changed} onClick={() => void apply()}>{saving ? "Saving…" : "Apply proxy"}</Button>
        {saved ? <span role="status" className="text-xs text-muted-foreground">Proxy saved</span> : null}
      </div>
    </section>
  );
}
