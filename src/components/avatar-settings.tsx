import { t, useTranslation } from "@/i18n";
import { useId, useRef, useState } from "react";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import type { AvatarProvider } from "@/lib/avatar";

const PROVIDERS: { value: AvatarProvider; label: string }[] = [
  { value: "builtin", get label() { return t("desktop.avatarSettings.built_in"); } },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

export function AvatarSettings({ provider, onSave }: {
  provider: AvatarProvider;
  onSave: (provider: AvatarProvider) => Promise<unknown>;
}) {
  useTranslation();
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
          <span id={labelId} className="text-sm">{t("desktop.avatarSettings.author_avatars")}</span>
          <HoverTip label={t("desktop.avatarSettings.built_in_stays_offline_choosing_github_or_gitlab")}>
            <Button variant="ghost" size="icon-xs" aria-label={t("desktop.avatarSettings.about_author_avatar_providers")}><InfoIcon /></Button>
          </HoverTip>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="min-w-32 justify-between" aria-labelledby={`${labelId} ${labelId}-choice`} disabled={saving}>
              <span id={`${labelId}-choice`}>{saving ? t("desktop.networkSettings.saving") : PROVIDERS.find((item) => item.value === provider)?.label}</span><ChevronDownIcon />
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
      <p role="status" className="text-xs text-muted-foreground">{provider === "builtin" ? t("desktop.avatarSettings.built_in_avatars_stay_offline") : t("desktop.avatarSettings.providerNotice", { provider: provider === "github" ? "GitHub" : "GitLab" })}</p>
      {error ? <p role="alert" className="text-xs text-destructive">{t("desktop.avatarSettings.could_not_save_the_avatar_provider_try_again")}</p> : null}
    </div>
  );
}
