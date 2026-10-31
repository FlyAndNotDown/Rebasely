import { useTranslation } from "@/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { normalizeRepoPath } from "@/lib/format";
import { fuzzyScore } from "@/lib/fuzzy";
import { SHORTCUTS, formatCombo, isEditableTarget, matchesCombo, type ShortcutId } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { WELCOME_TAB_ID, useGitPick } from "@/state/git-context";
import { asVcs } from "@/state/session";
import { useP4 } from "@/state/p4-context";

interface Command {
  id: string;
  label: string;
  group: string;
  detail?: string;
  shortcut?: ShortcutId;
  /** Generated per branch or repository; only a few show until the user types. */
  dynamic?: boolean;
  run: () => void;
}

const QUIET_LIMIT = 6;

/** Owns the app-wide shortcuts and the command palette that lists them. */
export function CommandCenter() {
  const { t } = useTranslation();
  const git = useGitPick([
    "snapshot",
    "recents",
    "tabs",
    "activeTabId",
    "prefs",
    "openPanel",
    "setOpenPanel",
    "setView",
    "setActiveTab",
    "openFolder",
    "openPath",
    "closeRepo",
    "refreshRepository",
    "fetchRemote",
    "fetchAllRemotes",
    "pullRemote",
    "pushRemote",
    "stashSave",
    "undoLastCommit",
    "checkoutBranch",
    "openInEditor",
    "openTerminal",
    "revealRepo",
    "applyPatch",
    "setDiffOptions",
    "updatePrefs",
  ]);
  const p4 = useP4();
  const {
    snapshot,
    recents,
    tabs,
    activeTabId,
    prefs,
    openPanel,
    setOpenPanel,
  } = git;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const perforceOpen = activeTab?.kind === "repo" && activeTab.vcs === "perforce";
  const repoOpen = activeTabId !== WELCOME_TAB_ID && snapshot !== null && !perforceOpen;

  const commands = useMemo(() => {
    const list: Command[] = [];
    const cycle = (step: number) => {
      if (tabs.length === 0) return;
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const start = index < 0 ? (step > 0 ? -1 : 0) : index;
      const next = tabs[(start + step + tabs.length) % tabs.length];
      if (next) git.setActiveTab(next.id);
    };
    if (perforceOpen) {
      list.push(
        { id: "view-pending", label: t("desktop.commandPalette.go_to_pending"), group: t("desktop.commandPalette.navigate"), shortcut: "viewChanges", run: () => p4.setView("pending") },
        { id: "view-submitted", label: t("desktop.commandPalette.go_to_history"), group: t("desktop.commandPalette.navigate"), shortcut: "viewHistory", run: () => p4.setView("submitted") },
        { id: "view-workspace", label: t("desktop.commandPalette.go_to_workspace"), group: t("desktop.commandPalette.navigate"), shortcut: "viewStash", run: () => p4.setView("workspace") },
        { id: "sync", label: t("desktop.commandPalette.get_latest"), group: t("desktop.appSidebar.workspace"), shortcut: "fetch", run: () => void p4.sync() },
        { id: "reconcile", label: t("desktop.commandPalette.reconcile_offline_work"), group: t("desktop.appSidebar.workspace"), run: () => void p4.reconcile() },
        { id: "refresh-p4", label: t("desktop.commandPalette.refresh_workspace"), group: t("desktop.appSidebar.workspace"), run: () => void p4.refresh() },
        { id: "editor", label: t("desktop.appHeader.open_in_editor"), group: t("desktop.commandPalette.repository"), shortcut: "openInEditor", run: () => void git.openInEditor() },
        { id: "terminal", label: t("desktop.appHeader.open_terminal"), group: t("desktop.commandPalette.repository"), shortcut: "openTerminal", run: () => void git.openTerminal() },
        { id: "reveal", label: t("desktop.sshKeysSettings.open_folder"), group: t("desktop.commandPalette.repository"), run: () => void git.revealRepo() },
        { id: "close", label: t("desktop.commandPalette.close_repository"), group: t("desktop.commandPalette.repository"), shortcut: "closeRepository", run: () => git.closeRepo() },
        {
          id: "toggle-split",
          label: prefs.diffSplit ? t("desktop.commandPalette.show_diffs_inline") : t("desktop.commandPalette.show_diffs_side_by_side"),
          group: t("desktop.commandPalette.view"),
          run: () => void git.setDiffOptions({ split: !prefs.diffSplit }),
        },
      );
    }
    if (repoOpen) {
      list.push(
        { id: "view-changes", label: t("desktop.commandPalette.go_to_changes"), group: t("desktop.commandPalette.navigate"), shortcut: "viewChanges", run: () => git.setView("changes") },
        { id: "view-history", label: t("desktop.commandPalette.go_to_history"), group: t("desktop.commandPalette.navigate"), shortcut: "viewHistory", run: () => git.setView("history") },
        { id: "view-stash", label: t("desktop.commandPalette.go_to_stash"), group: t("desktop.commandPalette.navigate"), shortcut: "viewStash", run: () => git.setView("stash") },
        { id: "view-files", label: t("desktop.commandPalette.go_to_files"), group: t("desktop.commandPalette.navigate"), shortcut: "viewFiles", run: () => git.setView("files") },
        { id: "refresh", label: t("common.refresh"), group: t("desktop.commandPalette.repository"), run: () => void git.refreshRepository() },
        { id: "fetch", label: t("desktop.appToolbar.fetch"), group: t("desktop.appToolbar.remote"), shortcut: "fetch", run: () => void git.fetchRemote() },
        { id: "fetch-all", label: t("desktop.commandPalette.fetch_all_remotes"), group: t("desktop.appToolbar.remote"), run: () => void git.fetchAllRemotes() },
        {
          id: "pull",
          label: prefs.pullRebase ? t("desktop.commandPalette.pull_rebase") : t("desktop.commandPalette.pull_merge"),
          group: t("desktop.appToolbar.remote"),
          shortcut: "pull",
          run: () => void git.pullRemote(undefined, prefs.pullRebase),
        },
        {
          id: "pull-other",
          label: prefs.pullRebase ? t("desktop.commandPalette.pull_with_merge") : t("desktop.commandPalette.pull_with_rebase"),
          group: t("desktop.appToolbar.remote"),
          run: () => void git.pullRemote(undefined, !prefs.pullRebase),
        },
        { id: "push", label: t("desktop.appToolbar.push"), group: t("desktop.appToolbar.remote"), shortcut: "push", run: () => void git.pushRemote() },
        ...(snapshot?.repo.headId ? [{ id: "new-branch", label: t("desktop.commandPalette.new_branch"), group: t("common.branch"), shortcut: "newBranch" as const, run: () => setOpenPanel("new-branch") }] : []),
        { id: "stash-all", label: t("desktop.commandPalette.stash_all_changes"), group: t("desktop.appSidebar.changes"), shortcut: "stashAll", run: () => void git.stashSave("", true) },
        { id: "undo-commit", label: t("desktop.commandPalette.undo_last_commit"), group: t("desktop.appSidebar.changes"), run: () => void git.undoLastCommit() },
        { id: "apply-patch", label: t("desktop.commandPalette.apply_patch"), group: t("desktop.appSidebar.changes"), run: () => void git.applyPatch() },
        { id: "reflog", label: t("desktop.commandPalette.show_reflog"), group: t("desktop.appSidebar.history"), shortcut: "reflog", run: () => setOpenPanel("reflog") },
        { id: "editor", label: t("desktop.appHeader.open_in_editor"), group: t("desktop.commandPalette.repository"), shortcut: "openInEditor", run: () => void git.openInEditor() },
        { id: "terminal", label: t("desktop.appHeader.open_terminal"), group: t("desktop.commandPalette.repository"), shortcut: "openTerminal", run: () => void git.openTerminal() },
        { id: "reveal", label: t("desktop.sshKeysSettings.open_folder"), group: t("desktop.commandPalette.repository"), run: () => void git.revealRepo() },
        { id: "close", label: t("desktop.commandPalette.close_repository"), group: t("desktop.commandPalette.repository"), shortcut: "closeRepository", run: () => git.closeRepo() },
        {
          id: "toggle-split",
          label: prefs.diffSplit ? t("desktop.commandPalette.show_diffs_inline") : t("desktop.commandPalette.show_diffs_side_by_side"),
          group: t("desktop.commandPalette.view"),
          run: () => void git.setDiffOptions({ split: !prefs.diffSplit }),
        },
        {
          id: "toggle-whitespace",
          label: prefs.diffIgnoreWhitespace ? t("desktop.commandPalette.show_whitespace_changes") : t("desktop.commandPalette.hide_whitespace_changes"),
          group: t("desktop.commandPalette.view"),
          run: () => void git.setDiffOptions({ ignoreWhitespace: !prefs.diffIgnoreWhitespace }),
        },
        {
          id: "toggle-tree",
          label: prefs.changesTree ? t("desktop.commandPalette.list_changed_files_flat") : t("desktop.commandPalette.group_changed_files_by_folder"),
          group: t("desktop.commandPalette.view"),
          run: () => void git.updatePrefs({ ...prefs, changesTree: !prefs.changesTree }),
        },
      );
    }
    list.push(
      { id: "open", label: t("desktop.commandPalette.open_local_repository"), group: t("desktop.commandPalette.repository"), shortcut: "openRepository", run: () => void git.openFolder() },
      { id: "next-tab", label: t("desktop.commandPalette.next_tab"), group: t("desktop.commandPalette.navigate"), shortcut: "nextTab", run: () => cycle(1) },
      { id: "previous-tab", label: t("desktop.commandPalette.previous_tab"), group: t("desktop.commandPalette.navigate"), shortcut: "previousTab", run: () => cycle(-1) },
      { id: "settings", label: t("common.settings"), group: t("desktop.commandPalette.app"), shortcut: "settings", run: () => setOpenPanel("settings") },
    );
    if (repoOpen) {
      const branch = snapshot.repo.currentBranch;
      for (const local of snapshot.branches.local) {
        if (local.name === branch) continue;
        list.push({
          id: `branch:${local.name}`,
          label: t("desktop.commandPalette.switchBranch", { name: local.name }),
          group: t("desktop.commandPalette.branches"),
          dynamic: true,
          run: () => void git.checkoutBranch(local.name),
        });
      }
      for (const remote of snapshot.branches.remote) {
        list.push({
          id: `remote:${remote.name}`,
          label: t("desktop.commandPalette.checkoutBranch", { name: remote.name }),
          group: t("desktop.appHeader.remote_branches"),
          dynamic: true,
          run: () => void git.checkoutBranch(remote.name),
        });
      }
    }
    const open = new Set(tabs.flatMap((tab) => (tab.kind === "repo" ? [normalizeRepoPath(tab.path)] : [])));
    for (const recent of recents) {
      if (open.has(normalizeRepoPath(recent.path))) continue;
      list.push({
        id: `repo:${recent.path}`,
        label: t("desktop.commandPalette.openRepository", { name: recent.name }),
        detail: recent.path,
        group: t("desktop.appMenu.recent_repositories"),
        dynamic: true,
        run: () => void git.openPath(recent.path, recent.vcs ? asVcs(recent.vcs) : undefined),
      });
    }
    return list;
  }, [t, activeTabId, git, p4, perforceOpen, prefs, recents, repoOpen, setOpenPanel, snapshot, tabs]);

  const commandsRef = useRef(commands);
  const panelRef = useRef(openPanel);
  useLayoutEffect(() => {
    commandsRef.current = commands;
    panelRef.current = openPanel;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const otherDialog = panelRef.current !== "palette" && document.querySelector('[role="dialog"]') !== null;
      if (SHORTCUTS.palette.some((combo) => matchesCombo(event, combo))) {
        if (otherDialog) return;
        event.preventDefault();
        setOpenPanel(panelRef.current === "palette" ? null : "palette");
        return;
      }
      if (otherDialog || panelRef.current === "palette" || isEditableTarget(event.target)) return;
      for (const command of commandsRef.current) {
        if (!command.shortcut) continue;
        if (!SHORTCUTS[command.shortcut].some((combo) => matchesCombo(event, combo))) continue;
        event.preventDefault();
        command.run();
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpenPanel]);

  return (
    <Dialog open={openPanel === "palette"} onOpenChange={(open) => setOpenPanel(open ? "palette" : null)}>
      <DialogContent
        showCloseButton={false}
        className="top-[14%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{t("desktop.commandPalette.command_palette")}</DialogTitle>
        {openPanel === "palette" ? (
          <PaletteBody
            commands={commands}
            onRun={(command) => {
              setOpenPanel(null);
              command.run();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ commands, onRun }: { commands: Command[]; onRun: (command: Command) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) {
      const quiet = new Map<string, number>();
      return commands.filter((command) => {
        if (!command.dynamic) return true;
        const shown = quiet.get(command.group) ?? 0;
        if (command.group === t("desktop.appHeader.remote_branches") || shown >= QUIET_LIMIT) return false;
        quiet.set(command.group, shown + 1);
        return true;
      });
    }
    return commands
      .map((command) => ({ command, score: fuzzyScore(query, `${command.label} ${command.detail ?? ""}`) }))
      .filter((item): item is { command: Command; score: number } => item.score !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, 60)
      .map((item) => item.command);
  }, [t, commands, query]);
  const shown = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);

  return (
    <div className="flex max-h-[min(28rem,70vh)] flex-col">
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          placeholder={t("desktop.commandPalette.type_a_command_branch_or_repository")}
          aria-label={t("desktop.commandPalette.command")}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (current + step + results.length) % Math.max(1, results.length));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const command = results[shown];
              if (command) onRun(command);
            }
          }}
        />
      </div>
      <div role="listbox" aria-label={t("desktop.welcomeScreen.commands")} className="min-h-0 flex-1 overflow-y-auto p-1">
        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("desktop.commandPalette.no_matching_commands")}</p>
        ) : null}
        {results.map((command, index) => (
          <button
            key={command.id}
            ref={index === shown ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={index === shown}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-sm",
              index === shown ? "bg-muted" : "hover:bg-muted/60",
            )}
            onMouseMove={() => setActive(index)}
            onClick={() => onRun(command)}
          >
            <span className="min-w-0 flex-1 truncate">
              {command.label}
              {command.detail ? (
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">{command.detail}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{command.group}</span>
            {command.shortcut ? <Kbd>{formatCombo(SHORTCUTS[command.shortcut][0])}</Kbd> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
