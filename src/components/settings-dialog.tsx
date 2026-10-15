import { useEffect, useRef, useState, type ReactNode } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  KeyRoundIcon,
  ListIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { SshKeysSettings } from "@/components/ssh-keys-settings";
import { GitLogo, PerforceMark } from "@/components/vcs-icon";
import { errorMessage, gitApi } from "@/lib/git";
import { p4Api } from "@/lib/p4";
import { displayPath } from "@/lib/format";
import { AUTO_FETCH_CHOICES, isGitFileName, isP4FileName, normalizePrefs, sameGitPath, sameP4Path } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { AppPrefs, TerminalOption, ToolConfig } from "@/types/git";

type SettingsSection = "git" | "perforce" | "ssh" | "general";
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
      <DialogContent className="flex h-[min(40rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        {/* Mounted on each open, so the fields load fresh every time. */}
        <SettingsForm />
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm() {
  const { theme, setTheme } = useTheme();
  const { prefs, updatePrefs } = useGitPick(["prefs", "updatePrefs"]);
  const [section, setSection] = useState<SettingsSection>("general");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [terminalId, setTerminalId] = useState("auto");
  const [terminals, setTerminals] = useState<TerminalOption[]>([]);
  const [editorId, setEditorId] = useState("system");
  const [editors, setEditors] = useState<TerminalOption[]>([]);
  const [tools, setTools] = useState<ToolConfig>({ diffTool: "", mergeTool: "" });
  const [guiTools, setGuiTools] = useState<GuiTool[]>([]);
  const [guiToolsReady, setGuiToolsReady] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [autoFetch, setAutoFetch] = useState(String(prefs.autoFetchMinutes));
  const [prune, setPrune] = useState(prefs.fetchPrune);
  const [gitPath, setGitPath] = useState(prefs.gitPath);
  const [extraGitPaths, setExtraGitPaths] = useState(prefs.extraGitPaths);
  const [pathGit, setPathGit] = useState<string | null>(null);
  const [executablesReady, setExecutablesReady] = useState(false);
  const [addingGit, setAddingGit] = useState(false);
  const [p4Path, setP4Path] = useState(prefs.p4Path);
  const [extraP4Paths, setExtraP4Paths] = useState(prefs.extraP4Paths);
  const [pathP4, setPathP4] = useState<string | null>(null);
  const [p4Ready, setP4Ready] = useState(false);
  const [addingP4, setAddingP4] = useState(false);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() =>
    theme === "light" || theme === "dark" || theme === "system" ? theme : "dark",
  );
  const prefsNow = useRef(prefs);
  const prefsWrite = useRef(0);
  const identityReadyRef = useRef(false);
  const savedIdentity = useRef({ name: "", email: "" });
  const nameRef = useRef(name);
  const emailRef = useRef(email);
  const toolsRef = useRef(tools);
  const toolTimer = useRef<number | null>(null);
  nameRef.current = name;
  emailRef.current = email;
  toolsRef.current = tools;

  useEffect(() => {
    void Promise.all([
      gitApi.getGitIdentity(),
      gitApi.getPrefs(),
      gitApi.listTerminals(),
      gitApi.listEditors(),
      gitApi.getToolConfig(),
      gitApi.listGuiTools(),
      gitApi.gitExecutables(),
      p4Api.executables().catch(() => null),
    ])
      .then(([identity, loadedPrefs, options, editorOptions, toolConfig, installedTools, executables, p4Executables]) => {
        const prefs = normalizePrefs(loadedPrefs);
        const visibleEditors = editorOptions.filter((editor) => editor.available);
        const visibleTerminals = options.filter((terminal) => terminal.available);
        setName(identity.name);
        setEmail(identity.email);
        savedIdentity.current = { name: identity.name, email: identity.email };
        identityReadyRef.current = true;
        setIdentityReady(true);
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
        const p4OnPath = p4Executables?.pathP4 ?? null;
        const selectedP4 = prefs.p4Path && p4OnPath && sameP4Path(prefs.p4Path, p4OnPath) ? "" : prefs.p4Path;
        const p4Extras = prefs.extraP4Paths.filter((path) => !p4OnPath || !sameP4Path(path, p4OnPath));
        setPathP4(p4OnPath);
        setP4Path(selectedP4);
        setExtraP4Paths(
          selectedP4 && !p4Extras.some((path) => sameP4Path(path, selectedP4))
            ? [selectedP4, ...p4Extras]
            : p4Extras,
        );
        setP4Ready(true);
      })
      .catch((error) => toast.error(errorMessage(error)));
  }, []);

  useEffect(() => {
    if (prefsWrite.current === 0) prefsNow.current = prefs;
  }, [prefs]);

  useEffect(() => {
    return () => {
      if (toolTimer.current !== null) {
        window.clearTimeout(toolTimer.current);
        toolTimer.current = null;
        void gitApi.setToolConfig(toolsRef.current).catch((error: unknown) => toast.error(errorMessage(error)));
      }
      void commitIdentity();
    };
  }, []);

  async function persistPrefs(patch: Partial<AppPrefs>) {
    const generation = ++prefsWrite.current;
    const next = { ...prefsNow.current, ...patch };
    prefsNow.current = next;
    try {
      const saved = await updatePrefs(next);
      if (prefsWrite.current === generation) {
        prefsWrite.current = 0;
        prefsNow.current = saved;
      }
    } catch (error) {
      if (prefsWrite.current === generation) prefsWrite.current = 0;
      toast.error(errorMessage(error));
    }
  }

  async function commitIdentity() {
    if (!identityReadyRef.current) return;
    const nextName = nameRef.current.trim();
    const nextEmail = emailRef.current.trim();
    if (nextName === savedIdentity.current.name && nextEmail === savedIdentity.current.email) return;
    try {
      const saved = await gitApi.setGitIdentity({ name: nextName, email: nextEmail });
      savedIdentity.current = { name: saved.name, email: saved.email };
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function queueTools(next: ToolConfig, immediate: boolean) {
    toolsRef.current = next;
    setTools(next);
    if (toolTimer.current !== null) window.clearTimeout(toolTimer.current);
    const write = () => {
      toolTimer.current = null;
      void gitApi
        .setToolConfig({ diffTool: toolsRef.current.diffTool.trim(), mergeTool: toolsRef.current.mergeTool.trim() })
        .catch((error: unknown) => toast.error(errorMessage(error)));
    };
    if (immediate) write();
    else toolTimer.current = window.setTimeout(write, 400);
  }

  function changeTool(key: "diffTool" | "mergeTool", value: string) {
    const next = { ...toolsRef.current, [key]: value };
    const known = value.trim() === "" || guiTools.some((tool) => tool.id === value);
    queueTools(next, known);
  }

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
      void persistPrefs({ gitPath: "" });
      return;
    }
    setAddingGit(true);
    try {
      await gitApi.checkGitExecutable(picked);
      const extras = extraGitPaths.some((path) => sameGitPath(path, picked))
        ? extraGitPaths
        : [...extraGitPaths, picked];
      setExtraGitPaths(extras);
      setGitPath(picked);
      void persistPrefs({ gitPath: picked, extraGitPaths: extras });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAddingGit(false);
    }
  }

  function removeGitExecutable(path: string) {
    const extras = extraGitPaths.filter((item) => !sameGitPath(item, path));
    const nextPath = sameGitPath(gitPath, path) ? "" : gitPath;
    setExtraGitPaths(extras);
    setGitPath(nextPath);
    void persistPrefs({ gitPath: nextPath, extraGitPaths: extras });
  }

  function selectGitExecutable(path: string) {
    setGitPath(path);
    void persistPrefs({ gitPath: path, extraGitPaths });
  }

  async function addP4Executable() {
    const picked = await openFile({ multiple: false, title: "p4 executable" });
    if (typeof picked !== "string") return;
    if (!isP4FileName(picked)) {
      toast.error(
        typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
          ? "Choose a file named p4. On Windows, choose p4.exe."
          : "Choose a file named p4.",
      );
      return;
    }
    if (pathP4 && sameP4Path(picked, pathP4)) {
      setP4Path("");
      void persistPrefs({ p4Path: "" });
      return;
    }
    setAddingP4(true);
    try {
      await p4Api.checkExecutable(picked);
      const extras = extraP4Paths.some((path) => sameP4Path(path, picked))
        ? extraP4Paths
        : [...extraP4Paths, picked];
      setExtraP4Paths(extras);
      setP4Path(picked);
      void persistPrefs({ p4Path: picked, extraP4Paths: extras });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAddingP4(false);
    }
  }

  function removeP4Executable(path: string) {
    const extras = extraP4Paths.filter((item) => !sameP4Path(item, path));
    const nextPath = sameP4Path(p4Path, path) ? "" : p4Path;
    setExtraP4Paths(extras);
    setP4Path(nextPath);
    void persistPrefs({ p4Path: nextPath, extraP4Paths: extras });
  }

  function selectP4Executable(path: string) {
    setP4Path(path);
    void persistPrefs({ p4Path: path, extraP4Paths });
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-44 shrink-0 flex-col gap-1 border-r p-4">
          <NavButton active={section === "general"} icon={<SlidersHorizontalIcon />} onClick={() => setSection("general")}>
            General
          </NavButton>
          <NavButton active={section === "git"} icon={<GitLogo />} onClick={() => setSection("git")}>
            Git
          </NavButton>
          <NavButton active={section === "perforce"} icon={<PerforceMark />} onClick={() => setSection("perforce")}>
            Perforce
          </NavButton>
          <NavButton active={section === "ssh"} icon={<KeyRoundIcon />} onClick={() => setSection("ssh")}>
            SSH
          </NavButton>
        </aside>
        <ScrollArea className="min-w-0 flex-1" scrollbars="vertical">
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
                  busy={addingGit}
                  onSelect={selectGitExecutable}
                  onRemove={removeGitExecutable}
                  onAdd={() => void addGitExecutable()}
                />
                <FieldGroup title="Identity">
                  {identityReady ? (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="git-name">User name</Label>
                        <Input
                          id="git-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          onBlur={() => void commitIdentity()}
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
                          onBlur={() => void commitIdentity()}
                          placeholder="you@example.com"
                        />
                      </div>
                    </>
                  ) : (
                    <div role="status" aria-label="Loading Git identity" className="grid gap-4">
                      <div className="grid gap-2">
                        <Label>User name</Label>
                        <Skeleton className="h-8 w-full" />
                      </div>
                      <div className="grid gap-2">
                        <Label>Email</Label>
                        <Skeleton className="h-8 w-full" />
                      </div>
                    </div>
                  )}
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
                    onChange={(value) => {
                      setAutoFetch(value);
                      void persistPrefs({ autoFetchMinutes: Number(value) });
                    }}
                  />
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={prune}
                      onCheckedChange={(checked) => {
                        const fetchPrune = checked === true;
                        setPrune(fetchPrune);
                        void persistPrefs({ fetchPrune });
                      }}
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
                    onChange={(diffTool) => changeTool("diffTool", diffTool)}
                  />
                  <ToolPicker
                    id="merge-tool"
                    label="Merge tool"
                    value={tools.mergeTool}
                    tools={guiTools}
                    ready={guiToolsReady}
                    onChange={(mergeTool) => changeTool("mergeTool", mergeTool)}
                  />
                </FieldGroup>
              </div>
            </>
          ) : section === "perforce" ? (
            <>
              <DialogHeader>
                <DialogTitle>Perforce</DialogTitle>
                <DialogDescription>The p4 executable Rebasely runs.</DialogDescription>
              </DialogHeader>
              <div className="mt-6 grid gap-8">
                <P4ExecutableSection
                  ready={p4Ready}
                  pathP4={pathP4}
                  p4Path={p4Path}
                  extras={extraP4Paths}
                  busy={addingP4}
                  onSelect={selectP4Executable}
                  onRemove={removeP4Executable}
                  onAdd={() => void addP4Executable()}
                />
              </div>
            </>
          ) : section === "ssh" ? (
            <SshKeysSettings email={email} />
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
                    onChange={(value) => {
                      setThemeChoice(value);
                      setTheme(value);
                    }}
                  />
                </FieldGroup>
                <FieldGroup title="External Editor">
                  <AppPicker
                    id="editor-app"
                    options={editors.filter((editor) => editor.available)}
                    catalog={editors.filter((editor) => editor.id !== "system")}
                    value={editorId}
                    fallback="System default app"
                    onChange={(value) => {
                      setEditorId(value);
                      void persistPrefs({ editorId: value });
                    }}
                  />
                </FieldGroup>
                <FieldGroup title="Terminal">
                  <AppPicker
                    id="terminal-app"
                    options={terminals.filter((terminal) => terminal.available)}
                    catalog={terminals.filter((terminal) => terminal.id !== "auto")}
                    value={terminalId}
                    fallback="System default"
                    onChange={(value) => {
                      setTerminalId(value);
                      void persistPrefs({ terminalId: value });
                    }}
                  />
                </FieldGroup>
              </div>
            </>
          )}
        </div>
        </ScrollArea>
      </div>
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
  if (!ready) {
    return (
      <FieldGroup title="Executable">
        <Skeleton className="h-8 w-full" role="status" aria-label="Loading Git executable" />
      </FieldGroup>
    );
  }
  return (
    <FieldGroup title="Executable">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            disabled={busy}
          >
            {selectedPath ? (
              <GitExecutableLabel path={selectedPath} pathTag={!selectedCustom} />
            ) : (
              <span className="truncate text-muted-foreground">Not found</span>
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

function P4ExecutableSection({
  ready,
  pathP4,
  p4Path,
  extras,
  busy,
  onSelect,
  onRemove,
  onAdd,
}: {
  ready: boolean;
  pathP4: string | null;
  p4Path: string;
  extras: string[];
  busy: boolean;
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
  onAdd: () => void;
}) {
  const unusable = ready && !pathP4 && p4Path === "";
  const selectedCustom = extras.find((path) => sameP4Path(path, p4Path));
  const selectedPath = selectedCustom ?? (pathP4 && p4Path === "" ? pathP4 : null);
  if (!ready) {
    return (
      <FieldGroup title="Executable">
        <Skeleton className="h-8 w-full" role="status" aria-label="Loading p4 executable" />
      </FieldGroup>
    );
  }
  return (
    <FieldGroup title="Executable">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between font-normal" disabled={busy}>
            {selectedPath ? (
              <GitExecutableLabel path={selectedPath} pathTag={!selectedCustom} />
            ) : (
              <span className="truncate text-muted-foreground">Not found</span>
            )}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {pathP4 ? (
            <DropdownMenuItem className="min-w-0" onClick={() => onSelect("")}>
              <span className="min-w-4">{p4Path === "" ? <CheckIcon className="size-3.5" /> : null}</span>
              <GitExecutableLabel path={pathP4} pathTag />
            </DropdownMenuItem>
          ) : null}
          {extras.map((path) => (
            <DropdownMenuItem
              key={path}
              className="min-w-0"
              onSelect={(event) => {
                if (event.target instanceof Element && event.target.closest("[data-remove-p4]")) {
                  event.preventDefault();
                }
              }}
              onClick={() => onSelect(path)}
            >
              <span className="min-w-4">
                {sameP4Path(p4Path, path) ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <GitExecutableLabel path={path} />
              <button
                type="button"
                data-remove-p4=""
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
          {pathP4 || extras.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => window.setTimeout(onAdd, 0)}>
            <span className="min-w-4">
              <PlusIcon className="size-3.5" />
            </span>
            Add p4 executable
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {unusable ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="status">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {extras.length === 0
              ? "p4 executable was not found. Add one to continue."
              : "p4 executable was not found. Select one of the added executables."}
          </span>
        </p>
      ) : null}
    </FieldGroup>
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

  if (!ready) {
    return (
      <div className="grid gap-2" role="status" aria-label={`Loading ${label}`}>
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 min-w-0 flex-1" />
          <Skeleton className="size-8 shrink-0" />
        </div>
      </div>
    );
  }

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
  icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}
