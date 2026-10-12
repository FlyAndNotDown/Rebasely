import { useEffect, useState, type ReactNode } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, ListIcon, PlusIcon, XIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { errorMessage, gitApi } from "@/lib/git";
import { displayPath } from "@/lib/format";
import { AUTO_FETCH_CHOICES, isGitFileName, normalizePrefs, sameGitPath } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { TerminalOption, ToolConfig } from "@/types/git";

type SettingsSection = "git" | "general";
type GuiTool = { id: string; name: string; installed: boolean };
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
  const [editorId, setEditorId] = useState("system");
  const [editors, setEditors] = useState<TerminalOption[]>([]);
  const [tools, setTools] = useState<ToolConfig>({ diffTool: "", mergeTool: "" });
  const [guiTools, setGuiTools] = useState<GuiTool[]>([]);
  const [guiToolsReady, setGuiToolsReady] = useState(false);
  const [autoFetch, setAutoFetch] = useState(String(prefs.autoFetchMinutes));
  const [prune, setPrune] = useState(prefs.fetchPrune);
  const [gitPath, setGitPath] = useState(prefs.gitPath);
  const [extraGitPaths, setExtraGitPaths] = useState(prefs.extraGitPaths);
  const [pathGit, setPathGit] = useState<string | null>(null);
  const [executablesReady, setExecutablesReady] = useState(false);
  const [addingGit, setAddingGit] = useState(false);
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
      gitApi.listGuiTools(),
      gitApi.gitExecutables(),
    ])
      .then(([identity, loadedPrefs, options, editorOptions, toolConfig, installedTools, executables]) => {
        const prefs = normalizePrefs(loadedPrefs);
        const visibleEditors = editorOptions.filter((editor) => editor.available);
        const visibleTerminals = options.filter((terminal) => terminal.available);
        setName(identity.name);
        setEmail(identity.email);
        setTerminalId(
          visibleTerminals.some((terminal) => terminal.id === prefs.terminalId) ? prefs.terminalId : "auto",
        );
        setTerminals(options);
        setEditorId(
          prefs.editorId === "system" || visibleEditors.some((editor) => editor.id === prefs.editorId)
            ? prefs.editorId
            : "system",
        );
        setEditors(editorOptions);
        setTools(toolConfig);
        setGuiTools(installedTools);
        setGuiToolsReady(true);
        setAutoFetch(String(prefs.autoFetchMinutes));
        setPrune(prefs.fetchPrune);
        const onPath = executables.pathGit;
        const selected = prefs.gitPath && onPath && sameGitPath(prefs.gitPath, onPath) ? "" : prefs.gitPath;
        const extras = prefs.extraGitPaths.filter((path) => !onPath || !sameGitPath(path, onPath));
        setPathGit(onPath);
        setGitPath(selected);
        setExtraGitPaths(
          selected && !extras.some((path) => sameGitPath(path, selected)) ? [selected, ...extras] : extras,
        );
        setExecutablesReady(true);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, []);

  async function addGitExecutable() {
    const picked = await openFile({ multiple: false, title: "Git executable" });
    if (typeof picked !== "string") return;
    if (!isGitFileName(picked)) {
      toast.error(
        typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
          ? "Choose a file named git. On Windows, choose git.exe."
          : "Choose a file named git.",
      );
      return;
    }
    if (pathGit && sameGitPath(picked, pathGit)) {
      setGitPath("");
      return;
    }
    setAddingGit(true);
    try {
      await gitApi.checkGitExecutable(picked);
      setExtraGitPaths((current) =>
        current.some((path) => sameGitPath(path, picked)) ? current : [...current, picked],
      );
      setGitPath(picked);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAddingGit(false);
    }
  }

  function removeGitExecutable(path: string) {
    setExtraGitPaths((current) => current.filter((item) => !sameGitPath(item, path)));
    setGitPath((current) => (sameGitPath(current, path) ? "" : current));
  }

  async function save() {
    setSaving(true);
    try {
      await updatePrefs({
        ...prefs,
        terminalId,
        editorId,
        autoFetchMinutes: Number(autoFetch),
        fetchPrune: prune,
        gitPath,
        extraGitPaths,
      });
      await Promise.all([
        gitApi.setGitIdentity({ name: name.trim(), email: email.trim() }),
        gitApi.setToolConfig({ diffTool: tools.diffTool.trim(), mergeTool: tools.mergeTool.trim() }),
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
                  The Git executable Rebasely runs, plus identity, fetching, and the diff and merge tools in your
                  global Git config.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-6 grid gap-8">
                <GitExecutableSection
                  ready={executablesReady}
                  pathGit={pathGit}
                  gitPath={gitPath}
                  extras={extraGitPaths}
                  busy={saving || addingGit}
                  onSelect={setGitPath}
                  onRemove={removeGitExecutable}
                  onAdd={() => void addGitExecutable()}
                />
                <FieldGroup title="Identity">
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
                </FieldGroup>
                <FieldGroup title="Fetching">
                  <SelectField
                    id="auto-fetch"
                    label="Fetch in the background"
                    value={autoFetch}
                    options={AUTO_FETCH_CHOICES.map((minutes) => ({
                      id: String(minutes),
                      label: minutes === 0 ? "Never" : `Every ${minutes} minutes`,
                    }))}
                    onChange={setAutoFetch}
                  />
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={prune}
                      onCheckedChange={(checked) => setPrune(checked === true)}
                    />
                    <span>
                      Prune when fetching
                      <span className="block text-xs text-muted-foreground">
                        Removes remote branches that were deleted on the remote.
                      </span>
                    </span>
                  </label>
                </FieldGroup>
                <FieldGroup title="Diff and merge">
                  <ToolPicker
                    id="diff-tool"
                    label="Diff tool"
                    value={tools.diffTool}
                    tools={guiTools}
                    ready={guiToolsReady}
                    onChange={(diffTool) => setTools((current) => ({ ...current, diffTool }))}
                  />
                  <ToolPicker
                    id="merge-tool"
                    label="Merge tool"
                    value={tools.mergeTool}
                    tools={guiTools}
                    ready={guiToolsReady}
                    onChange={(mergeTool) => setTools((current) => ({ ...current, mergeTool }))}
                  />
                </FieldGroup>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>General</DialogTitle>
                <DialogDescription>
                  Appearance, and the apps used to open a repository.
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
                </FieldGroup>
                <FieldGroup title="External Editor">
                  <AppPicker
                    id="editor-app"
                    options={editors.filter((editor) => editor.available)}
                    catalog={editors.filter((editor) => editor.id !== "system")}
                    value={editorId}
                    fallback="System default app"
                    onChange={setEditorId}
                  />
                </FieldGroup>
                <FieldGroup title="Terminal">
                  <AppPicker
                    id="terminal-app"
                    options={terminals.filter((terminal) => terminal.available)}
                    catalog={terminals.filter((terminal) => terminal.id !== "auto")}
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
  catalog,
  value,
  fallback,
  onChange,
}: {
  id: string;
  options: TerminalOption[];
  catalog: TerminalOption[];
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Application</Label>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button id={id} type="button" variant="outline" className="min-w-0 flex-1 justify-between font-normal">
              <span className="truncate">{options.find((item) => item.id === value)?.name ?? fallback}</span>
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onClick={() => onChange(option.id)}>
                <span className="min-w-4">{option.id === value ? <CheckIcon className="size-3.5" /> : null}</span>
                <span className="truncate">{option.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <SupportList items={catalog} />
      </div>
    </div>
  );
}

function SupportList({ items }: { items: { id: string; name: string; available: boolean }[] }) {
  const installed = items.filter((item) => item.available);
  const missing = items.filter((item) => !item.available);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label="Supported tools" title="Supported tools">
          <ListIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <SupportGroup title="Installed" items={installed} />
        <DropdownMenuSeparator />
        <SupportGroup title="Not installed" items={missing} muted />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SupportGroup({
  title,
  items,
  muted = false,
}: {
  title: string;
  items: { id: string; name: string }[];
  muted?: boolean;
}) {
  return (
    <>
      <DropdownMenuLabel>{title}</DropdownMenuLabel>
      {items.length === 0 ? (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">None</p>
      ) : (
        items.map((item) => (
          <div key={item.id} className={cn("truncate px-1.5 py-1 text-sm", muted && "text-muted-foreground")}>
            {item.name}
          </div>
        ))
      )}
    </>
  );
}

function GitExecutableSection({
  ready,
  pathGit,
  gitPath,
  extras,
  busy,
  onSelect,
  onRemove,
  onAdd,
}: {
  ready: boolean;
  pathGit: string | null;
  gitPath: string;
  extras: string[];
  busy: boolean;
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
  onAdd: () => void;
}) {
  const unusable = ready && !pathGit && gitPath === "";
  const selectedCustom = extras.find((path) => sameGitPath(path, gitPath));
  const selectedPath = selectedCustom ?? (pathGit && gitPath === "" ? pathGit : null);
  return (
    <FieldGroup title="Executable">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            disabled={!ready || busy}
          >
            {selectedPath ? (
              <GitExecutableLabel path={selectedPath} pathTag={!selectedCustom} />
            ) : (
              <span className="truncate text-muted-foreground">
                {ready ? "Not found" : "Looking for Git on PATH…"}
              </span>
            )}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {pathGit ? (
            <DropdownMenuItem className="min-w-0" onClick={() => onSelect("")}>
              <span className="min-w-4">{gitPath === "" ? <CheckIcon className="size-3.5" /> : null}</span>
              <GitExecutableLabel path={pathGit} pathTag />
            </DropdownMenuItem>
          ) : null}
          {extras.map((path) => (
            <DropdownMenuItem
              key={path}
              className="min-w-0"
              onSelect={(event) => {
                if (event.target instanceof Element && event.target.closest("[data-remove-git]")) {
                  event.preventDefault();
                }
              }}
              onClick={() => onSelect(path)}
            >
              <span className="min-w-4">
                {sameGitPath(gitPath, path) ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <GitExecutableLabel path={path} />
              <button
                type="button"
                data-remove-git=""
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${displayPath(path)}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemove(path);
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          {pathGit || extras.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => window.setTimeout(onAdd, 0)}>
            <span className="min-w-4">
              <PlusIcon className="size-3.5" />
            </span>
            Add Git executable
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {unusable ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="status">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {extras.length === 0
              ? "Git executable was not found. Add one to continue."
              : "Git executable was not found. Select one of the added executables."}
          </span>
        </p>
      ) : null}
    </FieldGroup>
  );
}

function GitExecutableLabel({ path, pathTag = false }: { path: string; pathTag?: boolean }) {
  const label = displayPath(path);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 truncate font-mono text-xs" title={label}>
        {label}
      </span>
      {pathTag ? (
        <span className="inline-flex h-4 shrink-0 items-center rounded border bg-background px-1.5 font-sans text-[10px] leading-none text-muted-foreground">
          PATH
        </span>
      ) : null}
    </span>
  );
}

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4">
      <h3 className="flex items-center gap-3 text-sm font-semibold tracking-wide text-foreground">
        <span>{title}</span>
        <span className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

const CUSTOM_TOOL = "__custom__";

function ToolPicker({
  id,
  label,
  value,
  tools,
  ready,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  tools: GuiTool[];
  ready: boolean;
  onChange: (value: string) => void;
}) {
  const [customOverride, setCustomOverride] = useState<boolean | null>(null);
  const [probe, setProbe] = useState<{ value: string; found: boolean } | null>(null);
  const known = tools.some((tool) => tool.id === value);
  const choices = tools.filter((tool) => tool.installed);
  const custom = customOverride ?? (ready && value !== "" && !known);
  const trimmed = value.trim();
  const missing = custom && trimmed !== "" && probe?.value === trimmed && !probe.found;

  useEffect(() => {
    if (!custom || !trimmed) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void gitApi
        .guiToolFound(trimmed)
        .then((found) => {
          if (!cancelled) setProbe({ value: trimmed, found });
        })
        .catch(() => {
          if (!cancelled) setProbe({ value: trimmed, found: true });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [custom, trimmed]);

  const selected = custom ? CUSTOM_TOOL : value;
  const selectedLabel = custom
    ? "Custom executable"
    : (tools.find((tool) => tool.id === value)?.name ?? (value ? value : "None"));

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button id={id} type="button" variant="outline" className="min-w-0 flex-1 justify-between font-normal">
            <span className="truncate">{selectedLabel}</span>
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuItem
            onClick={() => {
              setCustomOverride(false);
              onChange("");
            }}
          >
            <span className="min-w-4">{selected === "" ? <CheckIcon className="size-3.5" /> : null}</span>
            None
          </DropdownMenuItem>
          {choices.map((tool) => (
            <DropdownMenuItem
              key={tool.id}
              onClick={() => {
                setCustomOverride(false);
                onChange(tool.id);
              }}
            >
              <span className="min-w-4">{selected === tool.id ? <CheckIcon className="size-3.5" /> : null}</span>
              {tool.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setCustomOverride(true);
              if (tools.some((tool) => tool.id === value)) onChange("");
            }}
          >
            <span className="min-w-4">{selected === CUSTOM_TOOL ? <CheckIcon className="size-3.5" /> : null}</span>
            Custom executable
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SupportList items={tools.map((tool) => ({ id: tool.id, name: tool.name, available: tool.installed }))} />
      </div>
      {custom ? (
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Path to an executable"
            spellCheck={false}
            className="min-w-0 flex-1"
          />
          <span className="size-8 shrink-0" />
        </div>
      ) : null}
      {missing ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="status">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          Executable not found
        </p>
      ) : null}
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
