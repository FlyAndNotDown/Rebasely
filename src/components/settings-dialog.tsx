import { useEffect, useRef, useState, type ReactNode } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ActivityIcon,
  GlobeIcon,
  InfoIcon,
  KeyRoundIcon,
  ListIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { UpdatesSettings } from "@/components/app-updates";
import { NetworkSettings } from "@/components/network-settings";
import { DiagnosticsSettings } from "@/components/diagnostics-settings";
import { AvatarSettings } from "@/components/avatar-settings";
import { GitLogo, PerforceMark } from "@/components/vcs-icon";
import { errorMessage, gitApi } from "@/lib/git";
import { p4Api } from "@/lib/p4";
import { loadSettingsData } from "@/lib/settings-data";
import { createSettingsWriter } from "@/lib/settings-writes";
import { displayPath } from "@/lib/format";
import { AUTO_FETCH_CHOICES, isGitFileName, isP4FileName, normalizePrefs, sameGitPath, sameP4Path } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import { useAnalyticsSessionAllowed } from "@/state/use-analytics";
import { setAnalyticsSessionAllowed } from "@/lib/analytics";
import type { AppPrefs, TerminalOption, ToolConfig } from "@/types/git";
import { t, type LanguagePreference , useTranslation} from "@/i18n";

type SettingsSection = "git" | "perforce" | "ssh" | "general" | "network" | "diagnostics";
type GuiTool = { id: string; name: string; installed: boolean };
type ThemeChoice = "dark" | "light" | "system";

const themeOptions: { id: ThemeChoice; label: string }[] = [
  { id: "dark", get label() { return t("desktop.settingsDialog.dark"); } },
  { id: "light", get label() { return t("desktop.settingsDialog.light"); } },
  { id: "system", get label() { return t("desktop.settingsDialog.system"); } },
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
  useTranslation();
  const { theme, setTheme } = useTheme();
  const { prefs, updatePrefs } = useGitPick(["prefs", "updatePrefs"]);
  const analyticsAllowed = useAnalyticsSessionAllowed();
  const [analyticsSaving, setAnalyticsSaving] = useState(false);
  const [analyticsSaveFailed, setAnalyticsSaveFailed] = useState(false);
  const analyticsSaveBusy = useRef(false);
  const [section, setSection] = useState<SettingsSection>("general");
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [toolConfigReady, setToolConfigReady] = useState(false);
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
  const [p4Refresh, setP4Refresh] = useState(String(prefs.p4RefreshMinutes));
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() =>
    theme === "light" || theme === "dark" || theme === "system" ? theme : "dark",
  );
  const prefsWriter = useRef(createSettingsWriter(prefs));
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
    let live = true;
    const revision = prefsWriter.current.revision;
    const identityAtStart = { name: nameRef.current, email: emailRef.current };
    const toolsAtStart = toolsRef.current;
    void loadSettingsData()
      .then((data) => {
        if (!live) return;
        const { identity, tools: toolConfig, gitExecutables: executables, p4Executables } = data;
        const options = data.terminals ?? [];
        const editorOptions = data.editors ?? [];
        const prefs = normalizePrefs(data.prefs ?? prefsWriter.current.value);
        const visibleEditors = editorOptions.filter((editor) => editor.available);
        const visibleTerminals = options.filter((terminal) => terminal.available);
        const applyPrefs = data.prefs !== null && revision === prefsWriter.current.revision;
        if (identity && nameRef.current === identityAtStart.name && emailRef.current === identityAtStart.email) {
          setName(identity.name);
          setEmail(identity.email);
          savedIdentity.current = { name: identity.name, email: identity.email };
        }
        identityReadyRef.current = identity !== null;
        setIdentityReady(identity !== null);
        if (applyPrefs) setTerminalId(
          visibleTerminals.some((terminal) => terminal.id === prefs.terminalId) ? prefs.terminalId : "auto",
        );
        setTerminals(options);
        if (applyPrefs) setEditorId(
          prefs.editorId === "system" || visibleEditors.some((editor) => editor.id === prefs.editorId)
            ? prefs.editorId
            : "system",
        );
        setEditors(editorOptions);
        if (toolConfig && toolsRef.current === toolsAtStart) {
          toolsRef.current = toolConfig;
          setTools(toolConfig);
        }
        setToolConfigReady(toolConfig !== null);
        setGuiTools(data.guiTools ?? []);
        setGuiToolsReady(true);
        if (applyPrefs) setAutoFetch(String(prefs.autoFetchMinutes));
        if (applyPrefs) setP4Refresh(String(prefs.p4RefreshMinutes));
        if (applyPrefs) setPrune(prefs.fetchPrune);
        const onPath = executables?.pathGit ?? null;
        const selected = prefs.gitPath && onPath && sameGitPath(prefs.gitPath, onPath) ? "" : prefs.gitPath;
        const extras = prefs.extraGitPaths.filter((path) => !onPath || !sameGitPath(path, onPath));
        setPathGit(onPath);
        if (applyPrefs) setGitPath(selected);
        if (applyPrefs) setExtraGitPaths(
          selected && !extras.some((path) => sameGitPath(path, selected)) ? [selected, ...extras] : extras,
        );
        setExecutablesReady(true);
        const p4OnPath = p4Executables?.pathP4 ?? null;
        const selectedP4 = prefs.p4Path && p4OnPath && sameP4Path(prefs.p4Path, p4OnPath) ? "" : prefs.p4Path;
        const p4Extras = prefs.extraP4Paths.filter((path) => !p4OnPath || !sameP4Path(path, p4OnPath));
        setPathP4(p4OnPath);
        if (applyPrefs) setP4Path(selectedP4);
        if (applyPrefs) setExtraP4Paths(
          selectedP4 && !p4Extras.some((path) => sameP4Path(path, selectedP4))
            ? [selectedP4, ...p4Extras]
            : p4Extras,
        );
        setP4Ready(true);
        setIncomplete(data.incomplete);
        setLoaded(true);
      })
      .catch((error) => toast.error(errorMessage(error)));
    return () => { live = false; };
  }, [reload]);

  useEffect(() => {
    prefsWriter.current.sync(prefs);
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
    try {
      await prefsWriter.current.save(patch, updatePrefs);
      if ("gitPath" in patch || "p4Path" in patch) setReload((value) => value + 1);
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    }
  }

  async function changeAnalytics(enabled: boolean) {
    if (analyticsSaveBusy.current) return;
    analyticsSaveBusy.current = true;
    setAnalyticsSaving(true);
    setAnalyticsSaveFailed(false);
    if (!enabled) setAnalyticsSessionAllowed(false);
    try {
      const saved = await persistPrefs({ analyticsEnabled: enabled });
      if (saved) setAnalyticsSessionAllowed(enabled);
      else setAnalyticsSaveFailed(true);
    } finally {
      analyticsSaveBusy.current = false;
      setAnalyticsSaving(false);
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
    const picked = await openFile({ multiple: false, title: t("desktop.settingsDialog.git_executable") });
    if (typeof picked !== "string") return;
    if (!isGitFileName(picked)) {
      toast.error(
        typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
          ? t("desktop.settingsDialog.choose_a_file_named_git_on_windows_choose")
          : t("desktop.settingsDialog.choose_a_file_named_git"),
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
    const picked = await openFile({ multiple: false, title: t("desktop.settingsDialog.p4_executable") });
    if (typeof picked !== "string") return;
    if (!isP4FileName(picked)) {
      toast.error(
        typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
          ? t("desktop.settingsDialog.choose_a_file_named_p4_on_windows_choose")
          : t("desktop.settingsDialog.choose_a_file_named_p4"),
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
            {t("desktop.settingsDialog.general")}</NavButton>
          <NavButton active={section === "network"} icon={<GlobeIcon />} onClick={() => setSection("network")}>
            {t("desktop.settingsDialog.network")}</NavButton>
          <NavButton active={section === "git"} icon={<GitLogo />} onClick={() => setSection("git")}>
            Git
          </NavButton>
          <NavButton active={section === "perforce"} icon={<PerforceMark />} onClick={() => setSection("perforce")}>
            Perforce
          </NavButton>
          <NavButton active={section === "ssh"} icon={<KeyRoundIcon />} onClick={() => setSection("ssh")}>
            SSH
          </NavButton>
          <NavButton active={section === "diagnostics"} icon={<ActivityIcon />} onClick={() => setSection("diagnostics")}>
            {t("desktop.settingsDialog.diagnostics")}</NavButton>
        </aside>
        <ScrollArea key={section} className="min-w-0 flex-1" scrollbars="vertical">
        <div className="p-6">
          {incomplete ? (
            <div role="alert" className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/30 px-3 py-2 text-sm">
              <p className="min-w-0 flex-1">{t("desktop.settingsDialog.some_settings_could_not_be_loaded")}</p>
              <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button>
            </div>
          ) : null}
          {section === "git" ? (
            <>
              <DialogHeader>
                <DialogTitle>Git</DialogTitle>
                <DialogDescription>
                  {t("desktop.settingsDialog.executable_global_identity_and_tools")}</DialogDescription>
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
                <FieldGroup title={t("desktop.settingsDialog.identity")} hint={t("desktop.settingsDialog.saved_to_your_global_git_configuration_repository_settings")}>
                  {identityReady ? (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="git-name">{t("desktop.settingsDialog.user_name")}</Label>
                        <Input
                          id="git-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          onBlur={() => void commitIdentity()}
                          placeholder={t("desktop.settingsDialog.your_name")}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="git-email">{t("desktop.settingsDialog.email")}</Label>
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
                  ) : loaded ? (
                    <p className="text-sm text-muted-foreground">{t("desktop.settingsDialog.identity_settings_are_unavailable_check_the_git_executable")}</p>
                  ) : (
                    <div role="status" aria-label={t("desktop.settingsDialog.loading_git_identity")} className="grid gap-4">
                      <div className="grid gap-2">
                        <Label>{t("desktop.settingsDialog.user_name")}</Label>
                        <Skeleton className="h-8 w-full" />
                      </div>
                      <div className="grid gap-2">
                        <Label>{t("desktop.settingsDialog.email")}</Label>
                        <Skeleton className="h-8 w-full" />
                      </div>
                    </div>
                  )}
                </FieldGroup>
                <FieldGroup title={t("desktop.settingsDialog.fetching")}>
                  <SelectField
                    id="auto-fetch"
                    label={t("desktop.settingsDialog.fetch_in_the_background")}
                    value={autoFetch}
                    options={AUTO_FETCH_CHOICES.map((minutes) => ({
                      id: String(minutes),
                      label: minutes === 0 ? t("desktop.settingsDialog.never") : t("common.everyMinutes", { count: minutes }),
                    }))}
                    onChange={(value) => {
                      setAutoFetch(value);
                      void persistPrefs({ autoFetchMinutes: Number(value) });
                    }}
                  />
                  <label className="flex items-start gap-2 text-sm">
                    <HoverTip label={t("desktop.settingsDialog.remove_tracking_references_for_branches_deleted_on_the")}>
                    <Checkbox
                      className="mt-0.5"
                      checked={prune}
                      onCheckedChange={(checked) => {
                        const fetchPrune = checked === true;
                        setPrune(fetchPrune);
                        void persistPrefs({ fetchPrune });
                      }}
                    />
                    </HoverTip>
                    <span>{t("desktop.settingsDialog.prune_when_fetching")}</span>
                  </label>
                </FieldGroup>
                <FieldGroup title={t("desktop.settingsDialog.diff_and_merge")} hint={t("desktop.settingsDialog.saved_to_your_global_git_configuration_uses_git")}>
                  {loaded && !toolConfigReady ? (
                    <p className="text-sm text-muted-foreground">{t("desktop.settingsDialog.choose_a_git_executable_above_to_configure_diff")}</p>
                  ) : <>
                  <ToolPicker
                    id="diff-tool"
                    label={t("desktop.settingsDialog.diff_tool")}
                    value={tools.diffTool}
                    tools={guiTools}
                    ready={guiToolsReady}
                    onChange={(diffTool) => changeTool("diffTool", diffTool)}
                  />
                  <ToolPicker
                    id="merge-tool"
                    label={t("desktop.settingsDialog.merge_tool")}
                    value={tools.mergeTool}
                    tools={guiTools}
                    ready={guiToolsReady}
                    onChange={(mergeTool) => changeTool("mergeTool", mergeTool)}
                  />
                  </>}
                </FieldGroup>
              </div>
            </>
          ) : section === "perforce" ? (
            <>
              <DialogHeader>
                <DialogTitle>Perforce</DialogTitle>
                <DialogDescription>
                  {t("desktop.settingsDialog.executable_and_workspace_refresh")}</DialogDescription>
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
                <FieldGroup title={t("common.refresh")}>
                  <SelectField
                    id="p4-refresh"
                    label={t("desktop.settingsDialog.refresh_in_the_background")}
                    value={p4Refresh}
                    options={AUTO_FETCH_CHOICES.map((minutes) => ({
                      id: String(minutes),
                      label: minutes === 0 ? t("desktop.settingsDialog.never") : t("common.everyMinutes", { count: minutes }),
                    }))}
                    onChange={(value) => {
                      setP4Refresh(value);
                      void persistPrefs({ p4RefreshMinutes: Number(value) });
                    }}
                  />
                </FieldGroup>
              </div>
            </>
          ) : section === "ssh" ? (
            <SshKeysSettings email={email} />
          ) : section === "network" ? (
            <>
              <DialogHeader><DialogTitle>{t("desktop.settingsDialog.network")}</DialogTitle><DialogDescription>{t("desktop.settingsDialog.client_connection_settings")}</DialogDescription></DialogHeader>
              <div className="mt-6"><NetworkSettings value={prefs.httpProxy} onSave={(httpProxy) => persistPrefs({ httpProxy })} /></div>
            </>
          ) : section === "diagnostics" ? (
            <>
              <DialogHeader><DialogTitle>{t("desktop.settingsDialog.diagnostics")}</DialogTitle><DialogDescription>{t("desktop.settingsDialog.inspect_and_export_local_diagnostics")}</DialogDescription></DialogHeader>
              <div className="mt-6"><DiagnosticsSettings /></div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("desktop.settingsDialog.general")}</DialogTitle>
                <DialogDescription>
                  {t("desktop.settingsDialog.updates_appearance_and_external_apps")}</DialogDescription>
              </DialogHeader>
              <div className="mt-6 grid gap-8">
                <UpdatesSettings />
                <FieldGroup title={t("language.label")} hint={t("language.hint")}>
                  <SelectField<LanguagePreference>
                    id="language-choice"
                    label={t("language.label")}
                    value={prefs.language}
                    options={[
                      { id: "system", label: t("language.system") },
                      { id: "en", label: t("language.english") },
                      { id: "zh-CN", label: t("language.chinese") },
                    ]}
                    onChange={(language) => { void persistPrefs({ language }); }}
                  />
                </FieldGroup>
                <FieldGroup title={t("desktop.settingsDialog.appearance")}>
                  <SelectField
                    id="theme-choice"
                    label={t("desktop.settingsDialog.theme")}
                    value={themeChoice}
                    options={themeOptions}
                    onChange={(value) => {
                      setThemeChoice(value);
                      setTheme(value);
                    }}
                  />
                  <AvatarSettings
                    provider={prefs.avatarProvider}
                    onSave={async (avatarProvider) => {
                      if (!await persistPrefs({ avatarProvider })) throw new Error("Could not save the avatar provider.");
                    }}
                  />
                </FieldGroup>
                <FieldGroup title={t("analytics.title")}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={prefs.analyticsEnabled && analyticsAllowed}
                      disabled={analyticsSaving}
                      aria-describedby="analytics-disclosure"
                      onCheckedChange={(checked) => { void changeAnalytics(checked === true); }}
                    />
                    <span>{t("analytics.enabled")}</span>
                  </label>
                  <p id="analytics-disclosure" className="text-xs leading-relaxed text-muted-foreground">{t("analytics.disclosure")}</p>
                  {analyticsSaving ? <p className="text-xs text-muted-foreground" role="status">{t("analytics.saving")}</p> : null}
                  {analyticsSaveFailed ? <p className="text-sm text-destructive" role="alert">{t("analytics.saveFailed")}</p> : null}
                </FieldGroup>
                <FieldGroup title={t("desktop.settingsDialog.external_editor")}>
                  <AppPicker
                    id="editor-app"
                    options={editors.filter((editor) => editor.available)}
                    catalog={editors.filter((editor) => editor.id !== "system")}
                    value={editorId}
                    fallback={t("desktop.settingsDialog.system_default_app")}
                    onChange={(value) => {
                      setEditorId(value);
                      void persistPrefs({ editorId: value });
                    }}
                  />
                </FieldGroup>
                <FieldGroup title={t("desktop.settingsDialog.terminal")}>
                  <AppPicker
                    id="terminal-app"
                    options={terminals.filter((terminal) => terminal.available)}
                    catalog={terminals.filter((terminal) => terminal.id !== "auto")}
                    value={terminalId}
                    fallback={t("desktop.settingsDialog.system_default")}
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
  useTranslation();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t("desktop.settingsDialog.application")}</Label>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button id={id} type="button" variant="outline" className="min-w-0 flex-1 justify-between font-normal">
              <span className="truncate">{value === "system" ? t("desktop.settingsDialog.system_default_app") : value === "auto" ? t("desktop.settingsDialog.system_default") : options.find((item) => item.id === value)?.name ?? fallback}</span>
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onClick={() => onChange(option.id)}>
                <span className="min-w-4">{option.id === value ? <CheckIcon className="size-3.5" /> : null}</span>
                <span className="truncate">{option.id === "system" ? t("desktop.settingsDialog.system_default_app") : option.id === "auto" ? t("desktop.settingsDialog.system_default") : option.name}</span>
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
  useTranslation();
  const installed = items.filter((item) => item.available);
  const missing = items.filter((item) => !item.available);
  return (
    <DropdownMenu>
      <HoverTip label={t("desktop.settingsDialog.supported_tools")}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={t("desktop.settingsDialog.supported_tools")}>
            <ListIcon />
          </Button>
        </DropdownMenuTrigger>
      </HoverTip>
      <DropdownMenuContent align="end" className="w-64">
        <SupportGroup title={t("desktop.settingsDialog.installed")} items={installed} />
        <DropdownMenuSeparator />
        <SupportGroup title={t("desktop.settingsDialog.not_installed")} items={missing} muted />
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
  useTranslation();
  return (
    <>
      <DropdownMenuLabel>{title}</DropdownMenuLabel>
      {items.length === 0 ? (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">{t("desktop.settingsDialog.none")}</p>
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
  useTranslation();
  const unusable = ready && !pathGit && gitPath === "";
  const selectedCustom = extras.find((path) => sameGitPath(path, gitPath));
  const selectedPath = selectedCustom ?? (pathGit && gitPath === "" ? pathGit : null);
  if (!ready) {
    return (
      <FieldGroup title={t("desktop.settingsDialog.executable")}>
        <Skeleton className="h-8 w-full" role="status" aria-label={t("desktop.settingsDialog.loading_git_executable")} />
      </FieldGroup>
    );
  }
  return (
    <FieldGroup title={t("desktop.settingsDialog.executable")}>
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
              <span className="truncate text-muted-foreground">{t("desktop.settingsDialog.not_found")}</span>
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
              onClick={() => onSelect(path)}
            >
              <span className="min-w-4">
                {sameGitPath(gitPath, path) ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <GitExecutableLabel path={path} />
            </DropdownMenuItem>
          ))}
          {pathGit || extras.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => window.setTimeout(onAdd, 0)}>
            <span className="min-w-4">
              <PlusIcon className="size-3.5" />
            </span>
            {t("desktop.settingsDialog.add_git_executable")}</DropdownMenuItem>
          <ExecutableRemovalMenu paths={extras} onRemove={onRemove} />
        </DropdownMenuContent>
      </DropdownMenu>
      {unusable ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {extras.length === 0
              ? t("desktop.settingsDialog.git_executable_was_not_found_add_one_to")
              : t("desktop.settingsDialog.git_executable_was_not_found_select_one_of")}
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
      <HoverTip label={label}>
        <span className="min-w-0 truncate font-mono text-xs">{label}</span>
      </HoverTip>
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
  useTranslation();
  const unusable = ready && !pathP4 && p4Path === "";
  const selectedCustom = extras.find((path) => sameP4Path(path, p4Path));
  const selectedPath = selectedCustom ?? (pathP4 && p4Path === "" ? pathP4 : null);
  if (!ready) {
    return (
      <FieldGroup title={t("desktop.settingsDialog.executable")}>
        <Skeleton className="h-8 w-full" role="status" aria-label={t("desktop.settingsDialog.loading_p4_executable")} />
      </FieldGroup>
    );
  }
  return (
    <FieldGroup title={t("desktop.settingsDialog.executable")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between font-normal" disabled={busy}>
            {selectedPath ? (
              <GitExecutableLabel path={selectedPath} pathTag={!selectedCustom} />
            ) : (
              <span className="truncate text-muted-foreground">{t("desktop.settingsDialog.not_found")}</span>
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
              onClick={() => onSelect(path)}
            >
              <span className="min-w-4">
                {sameP4Path(p4Path, path) ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <GitExecutableLabel path={path} />
            </DropdownMenuItem>
          ))}
          {pathP4 || extras.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={() => window.setTimeout(onAdd, 0)}>
            <span className="min-w-4">
              <PlusIcon className="size-3.5" />
            </span>
            {t("desktop.settingsDialog.add_p4_executable")}</DropdownMenuItem>
          <ExecutableRemovalMenu paths={extras} onRemove={onRemove} />
        </DropdownMenuContent>
      </DropdownMenu>
      {unusable ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {extras.length === 0
              ? t("desktop.settingsDialog.p4_executable_was_not_found_add_one_to")
              : t("desktop.settingsDialog.p4_executable_was_not_found_select_one_of")}
          </span>
        </p>
      ) : null}
    </FieldGroup>
  );
}

function ExecutableRemovalMenu({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  useTranslation();
  if (paths.length === 0) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Trash2Icon />
        {t("desktop.settingsDialog.remove_executable")}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 max-w-96 overflow-y-auto [scrollbar-width:thin]">
        {paths.map((path) => (
          <DropdownMenuItem key={path} onSelect={() => onRemove(path)}>
            <GitExecutableLabel path={path} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function FieldGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  useTranslation();
  return (
    <section className="grid gap-4">
      <h3 className="flex items-center gap-3 text-sm font-semibold tracking-wide text-foreground">
        <span>{title}</span>
        {hint ? (
          <HoverTip label={hint}>
            <Button variant="ghost" size="icon-xs" aria-label={t("common.aboutNamed", { name: title })} className="text-muted-foreground">
              <InfoIcon />
            </Button>
          </HoverTip>
        ) : null}
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
  useTranslation();
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
    ? t("desktop.settingsDialog.custom_executable")
    : (tools.find((tool) => tool.id === value)?.name ?? (value ? value : t("desktop.settingsDialog.none")));

  if (!ready) {
    return (
      <div className="grid gap-2" role="status" aria-label={t("common.loadingNamed", { name: label })}>
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
            {t("desktop.settingsDialog.none")}</DropdownMenuItem>
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
            {t("desktop.settingsDialog.custom_executable")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SupportList items={tools.map((tool) => ({ id: tool.id, name: tool.name, available: tool.installed }))} />
      </div>
      {custom ? (
        <div className="flex gap-2">
          <Input
            aria-label={t("common.executablePath", { name: label })}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={t("desktop.settingsDialog.path_to_an_executable")}
            spellCheck={false}
            className="min-w-0 flex-1"
          />
          <span className="size-8 shrink-0" />
        </div>
      ) : null}
      {missing ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          {t("desktop.settingsDialog.executable_not_found")}</p>
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
      aria-current={active ? "page" : undefined}
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
