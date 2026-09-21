import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, gitApi } from "@/lib/git";
import { normalizePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { AvatarProvider, TerminalOption } from "@/types/git";

type SettingsSection = "git" | "general";
type ThemeChoice = "dark" | "light" | "system";

const avatarProviders: { id: AvatarProvider; label: string }[] = [
  { id: "dicebear", label: "DiceBear" },
];

const themeOptions: { id: ThemeChoice; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const { updatePrefs } = useGit();
  const [section, setSection] = useState<SettingsSection>("git");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [terminalId, setTerminalId] = useState("auto");
  const [avatarProvider, setAvatarProvider] = useState<AvatarProvider>("dicebear");
  const [terminals, setTerminals] = useState<TerminalOption[]>([]);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>("dark");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSection("git");
    void Promise.all([gitApi.getGitIdentity(), gitApi.getPrefs(), gitApi.listTerminals()])
      .then(([identity, loadedPrefs, options]) => {
        const prefs = normalizePrefs(loadedPrefs);
        setName(identity.name);
        setEmail(identity.email);
        setTerminalId(prefs.terminalId);
        setAvatarProvider(prefs.avatarProvider);
        setTerminals(options);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (theme === "light" || theme === "dark" || theme === "system") setThemeChoice(theme);
  }, [open, theme]);

  async function save() {
    setSaving(true);
    try {
      await Promise.all([
        gitApi.setGitIdentity({ name: name.trim(), email: email.trim() }),
        updatePrefs({
          terminalId,
          avatarProvider,
        }),
      ]);
      setTheme(themeChoice);
      toast.success("Saved settings");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none">
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-44 shrink-0 flex-col gap-1 border-r p-4">
            <NavButton active={section === "git"} onClick={() => setSection("git")}>
              Git
            </NavButton>
            <NavButton active={section === "general"} onClick={() => setSection("general")}>
              General
            </NavButton>
          </aside>
          <div className="min-w-0 flex-1 overflow-auto p-6">
            {section === "git" ? (
              <>
                <DialogHeader>
                  <DialogTitle>Git</DialogTitle>
                  <DialogDescription>
                    Global Git identity from your user Git config.
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-6 grid gap-5">
                  <div className="grid gap-2">
                    <Label htmlFor="git-name">User name</Label>
                    <Input
                      id="git-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Your name"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="git-email">Email</Label>
                    <Input
                      id="git-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>General</DialogTitle>
                  <DialogDescription>
                    Theme, author avatars, and the terminal used to open a repository.
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-6 grid gap-8">
                  <FieldGroup title="Appearance">
                    <SelectField
                      id="theme-choice"
                      label="Theme"
                      value={themeChoice}
                      options={themeOptions}
                      onChange={setThemeChoice}
                    />
                    <SelectField
                      id="avatar-provider"
                      label="Avatar provider"
                      value={avatarProvider}
                      options={avatarProviders}
                      onChange={setAvatarProvider}
                    />
                  </FieldGroup>
                  <FieldGroup title="Terminal">
                    <div className="grid gap-2">
                      <Label htmlFor="terminal-app">Application</Label>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            id="terminal-app"
                            type="button"
                            variant="outline"
                            className="w-full justify-between font-normal"
                          >
                            <span className="truncate">
                              {terminals.find((item) => item.id === terminalId)?.name ??
                                "System default"}
                            </span>
                            <ChevronDownIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-(--radix-dropdown-menu-trigger-width)"
                        >
                          {terminals.map((option) => (
                            <DropdownMenuItem
                              key={option.id}
                              disabled={!option.available}
                              onClick={() => setTerminalId(option.id)}
                            >
                              <span className="min-w-4">
                                {option.id === terminalId ? <CheckIcon className="size-3.5" /> : null}
                              </span>
                              <span className="truncate">{option.name}</span>
                              {!option.available ? (
                                <span className="ml-auto text-xs text-muted-foreground">
                                  Not found
                                </span>
                              ) : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </FieldGroup>
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter className="mx-0 mb-0 rounded-none">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-5">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}

function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
          >
            <span>{options.find((option) => option.id === value)?.label ?? options[0]?.label}</span>
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {options.map((option) => (
            <DropdownMenuItem key={option.id} onClick={() => onChange(option.id)}>
              <span className="min-w-4">
                {option.id === value ? <CheckIcon className="size-3.5" /> : null}
              </span>
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "w-full rounded-md px-2.5 py-1.5 text-left text-sm",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
