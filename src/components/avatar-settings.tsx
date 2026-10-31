import { useId, useRef, useState } from "react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import type { AvatarProvider } from "@/lib/avatar";

const PROVIDERS: { value: AvatarProvider; label: string }[] = [
  { value: "builtin", label: "Built-in" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

export function AvatarSettings({ provider, onSave }: {
  provider: AvatarProvider;
  onSave: (provider: AvatarProvider) => Promise<unknown>;
}) {
  const labelId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);

  async function select(next: AvatarProvider) {
    if (busy.current || next === provider) return;
    busy.current = true;
    setSaving(true);
    setError(false);
    try { await onSave(next); } catch { setError(true); }
    finally { busy.current = false; setSaving(false); }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span id={labelId} className="text-sm">Author avatars</span>
          <HoverTip label="Built-in stays offline. Choosing GitHub or GitLab sends commit email addresses to that provider to match public profiles. Unavailable avatars use the built-in style.">
            <Button variant="ghost" size="icon-xs" aria-label="About author avatar providers"><InfoIcon /></Button>
          </HoverTip>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="min-w-32 justify-between" aria-labelledby={`${labelId} ${labelId}-choice`} disabled={saving}>
              <span id={`${labelId}-choice`}>{saving ? "Saving…" : PROVIDERS.find((item) => item.value === provider)?.label}</span><ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={provider} onValueChange={(value) => {
              if (value === "builtin" || value === "github" || value === "gitlab") void select(value);
            }}>
              {PROVIDERS.map((item) => <DropdownMenuRadioItem key={item.value} value={item.value} disabled={saving}>{item.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p role="status" className="text-xs text-muted-foreground">{provider === "builtin" ? "Built-in avatars stay offline." : `Commit email addresses are sent to ${provider === "github" ? "GitHub" : "GitLab"} for public-profile matches.`}</p>
      {error ? <p role="alert" className="text-xs text-destructive">Could not save the avatar provider. Try again.</p> : null}
    </div>
  );
}
