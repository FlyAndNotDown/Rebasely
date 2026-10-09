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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { errorMessage, gitApi } from "@/lib/git";
import { normalizePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { TerminalOption, ToolConfig } from "@/types/git";

type SettingsSection = "git" | "general";

/** Tools git drives without extra config, plus the editors Rebasely can set up. */
const GIT_TOOLS = [
  "bc",
  "kdiff3",
  "meld",
  "p4merge",
  "winmerge",
  "tortoisemerge",
  "smerge",
  "araxis",
  "vscode",
  "cursor",
];
type ThemeChoice = "dark" | "light" | "system";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none">
        {/* Mounted on each open, so the fields load fresh every time. */}
        <SettingsForm onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { theme, setTheme } = useTheme();
  const { prefs, updatePrefs } = useGitPick(["prefs", "updatePrefs"]);
  const [section, setSection] = useState<SettingsSection>("git");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [terminalId, setTerminalId] = useState("auto");
  const [terminals, setTerminals] = useState<TerminalOption[]>([]);
  const [editorId, setEditorId] = useState("auto");
  const [editors, setEditors] = useState<TerminalOption[]>([]);
  const [tools, setTools] = useState<ToolConfig>({ diffTool: "", mergeTool: "" });
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() =>
    theme === "light" || theme === "dark" || theme === "system" ? theme : "dark",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([
      gitApi.getGitIdentity(),
      gitApi.getPrefs(),
      gitApi.listTerminals(),
      gitApi.listEditors(),
      gitApi.getToolConfig(),
    ])
      .then(([identity, loadedPrefs, options, editorOptions, toolConfig]) => {
        const prefs = normalizePrefs(loadedPrefs);
        setName(identity.name);
        setEmail(identity.email);
        setTerminalId(prefs.terminalId);
        setTerminals(options);
        setEditorId(prefs.editorId);
        setEditors(editorOptions);
        setTools(toolConfig);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await Promise.all([
        gitApi.setGitIdentity({ name: name.trim(), email: email.trim() }),
        gitApi.setToolConfig({ diffTool: tools.diffTool.trim(), mergeTool: tools.mergeTool.trim() }),
        updatePrefs({ ...prefs, terminalId, editorId }),
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
    <>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-44 shrink-0 flex-col gap-1 border-r p-4">
          <NavButton active={section === "git"} onClick={() => setSection("git")}>
            Git
          </NavButton>
          <NavButton active={section === "general"} onClick={() => setSection("general")}>
            General
          </NavButton>
        </aside>
        <ScrollArea className="min-w-0 flex-1">
        <div className="p-6">
          {section === "git" ? (
            <>
              <DialogHeader>
                <DialogTitle>Git</DialogTitle>
                <DialogDescription>
                  Identity and external tools from your global Git config.
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="diff-tool">Diff tool</Label>
                    <Input
                      id="diff-tool"
                      list="git-tool-names"
                      value={tools.diffTool}
                      onChange={(event) => setTools((current) => ({ ...current, diffTool: event.target.value }))}
                      placeholder="e.g. bc, meld, vscode"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="merge-tool">Merge tool</Label>
                    <Input
                      id="merge-tool"
                      list="git-tool-names"
                      value={tools.mergeTool}
                      onChange={(event) => setTools((current) => ({ ...current, mergeTool: event.target.value }))}
                      placeholder="e.g. kdiff3, p4merge, vscode"
                    />
                  </div>
                  <datalist id="git-tool-names">
                    {GIT_TOOLS.map((tool) => (
                      <option key={tool} value={tool} />
                    ))}
                  </datalist>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    Saved as diff.tool and merge.tool in your global Git config. Choosing vscode or
                    cursor also sets up the command they need.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>General</DialogTitle>
                <DialogDescription>Theme, and the editor and terminal used to open a repository.</DialogDescription>
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
                </FieldGroup>
                <FieldGroup title="Editor">
                  <AppPicker
                    id="editor-app"
                    options={[{ id: "auto", name: "First one found", available: true }, ...editors]}
                    value={editorId}
                    fallback="First one found"
                    onChange={setEditorId}
                  />
                </FieldGroup>
                <FieldGroup title="Terminal">
                  <AppPicker
                    id="terminal-app"
                    options={terminals}
                    value={terminalId}
                    fallback="System default"
                    onChange={setTerminalId}
                  />
                </FieldGroup>
              </div>
            </>
          )}
        </div>
        </ScrollArea>
      </div>
      <DialogFooter className="mx-0 mb-0 rounded-none">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

function AppPicker({
  id,
  options,
  value,
  fallback,
  onChange,
}: {
  id: string;
  options: TerminalOption[];
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Application</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button id={id} type="button" variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">{options.find((item) => item.id === value)?.name ?? fallback}</span>
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {options.map((option) => (
            <DropdownMenuItem key={option.id} disabled={!option.available} onClick={() => onChange(option.id)}>
              <span className="min-w-4">{option.id === value ? <CheckIcon className="size-3.5" /> : null}</span>
              <span className="truncate">{option.name}</span>
              {!option.available ? (
                <span className="ml-auto text-xs text-muted-foreground">Not found</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
