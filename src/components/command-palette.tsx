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
        { id: "view-pending", label: "Go to Pending", group: "Navigate", shortcut: "viewChanges", run: () => p4.setView("pending") },
        { id: "view-submitted", label: "Go to History", group: "Navigate", shortcut: "viewHistory", run: () => p4.setView("submitted") },
        { id: "view-workspace", label: "Go to Workspace", group: "Navigate", shortcut: "viewStash", run: () => p4.setView("workspace") },
        { id: "sync", label: "Get latest", group: "Workspace", shortcut: "fetch", run: () => void p4.sync() },
        { id: "reconcile", label: "Reconcile offline work", group: "Workspace", run: () => void p4.reconcile() },
        { id: "refresh-p4", label: "Refresh workspace", group: "Workspace", run: () => void p4.refresh() },
        { id: "editor", label: "Open in editor", group: "Repository", shortcut: "openInEditor", run: () => void git.openInEditor() },
        { id: "terminal", label: "Open terminal", group: "Repository", shortcut: "openTerminal", run: () => void git.openTerminal() },
        { id: "reveal", label: "Open folder", group: "Repository", run: () => void git.revealRepo() },
        { id: "close", label: "Close repository", group: "Repository", shortcut: "closeRepository", run: () => git.closeRepo() },
        {
          id: "toggle-split",
          label: prefs.diffSplit ? "Show diffs inline" : "Show diffs side by side",
          group: "View",
          run: () => void git.setDiffOptions({ split: !prefs.diffSplit }),
        },
      );
    }
    if (repoOpen) {
      list.push(
        { id: "view-changes", label: "Go to Changes", group: "Navigate", shortcut: "viewChanges", run: () => git.setView("changes") },
        { id: "view-history", label: "Go to History", group: "Navigate", shortcut: "viewHistory", run: () => git.setView("history") },
        { id: "view-stash", label: "Go to Stash", group: "Navigate", shortcut: "viewStash", run: () => git.setView("stash") },
        { id: "view-files", label: "Go to Files", group: "Navigate", shortcut: "viewFiles", run: () => git.setView("files") },
        { id: "refresh", label: "Refresh", group: "Repository", run: () => void git.refreshRepository() },
        { id: "fetch", label: "Fetch", group: "Remote", shortcut: "fetch", run: () => void git.fetchRemote() },
        { id: "fetch-all", label: "Fetch all remotes", group: "Remote", run: () => void git.fetchAllRemotes() },
        {
          id: "pull",
          label: prefs.pullRebase ? "Pull (rebase)" : "Pull (merge)",
          group: "Remote",
          shortcut: "pull",
          run: () => void git.pullRemote(undefined, prefs.pullRebase),
        },
        {
          id: "pull-other",
          label: prefs.pullRebase ? "Pull with merge" : "Pull with rebase",
          group: "Remote",
          run: () => void git.pullRemote(undefined, !prefs.pullRebase),
        },
        { id: "push", label: "Push", group: "Remote", shortcut: "push", run: () => void git.pushRemote() },
        ...(snapshot?.repo.headId ? [{ id: "new-branch", label: "New branch…", group: "Branch", shortcut: "newBranch" as const, run: () => setOpenPanel("new-branch") }] : []),
        { id: "stash-all", label: "Stash all changes", group: "Changes", shortcut: "stashAll", run: () => void git.stashSave("", true) },
        { id: "undo-commit", label: "Undo last commit", group: "Changes", run: () => void git.undoLastCommit() },
        { id: "apply-patch", label: "Apply patch…", group: "Changes", run: () => void git.applyPatch() },
        { id: "reflog", label: "Show reflog", group: "History", shortcut: "reflog", run: () => setOpenPanel("reflog") },
        { id: "editor", label: "Open in editor", group: "Repository", shortcut: "openInEditor", run: () => void git.openInEditor() },
        { id: "terminal", label: "Open terminal", group: "Repository", shortcut: "openTerminal", run: () => void git.openTerminal() },
        { id: "reveal", label: "Open folder", group: "Repository", run: () => void git.revealRepo() },
        { id: "close", label: "Close repository", group: "Repository", shortcut: "closeRepository", run: () => git.closeRepo() },
        {
          id: "toggle-split",
          label: prefs.diffSplit ? "Show diffs inline" : "Show diffs side by side",
          group: "View",
          run: () => void git.setDiffOptions({ split: !prefs.diffSplit }),
        },
        {
          id: "toggle-whitespace",
          label: prefs.diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes",
          group: "View",
          run: () => void git.setDiffOptions({ ignoreWhitespace: !prefs.diffIgnoreWhitespace }),
        },
        {
          id: "toggle-tree",
          label: prefs.changesTree ? "List changed files flat" : "Group changed files by folder",
          group: "View",
          run: () => void git.updatePrefs({ ...prefs, changesTree: !prefs.changesTree }),
        },
      );
    }
    list.push(
      { id: "open", label: "Open local repository…", group: "Repository", shortcut: "openRepository", run: () => void git.openFolder() },
      { id: "next-tab", label: "Next tab", group: "Navigate", shortcut: "nextTab", run: () => cycle(1) },
      { id: "previous-tab", label: "Previous tab", group: "Navigate", shortcut: "previousTab", run: () => cycle(-1) },
      { id: "settings", label: "Settings", group: "App", shortcut: "settings", run: () => setOpenPanel("settings") },
    );
    if (repoOpen) {
      const branch = snapshot.repo.currentBranch;
      for (const local of snapshot.branches.local) {
        if (local.name === branch) continue;
        list.push({
          id: `branch:${local.name}`,
          label: `Switch to ${local.name}`,
          group: "Branches",
          dynamic: true,
          run: () => void git.checkoutBranch(local.name),
        });
      }
      for (const remote of snapshot.branches.remote) {
        list.push({
          id: `remote:${remote.name}`,
          label: `Check out ${remote.name}`,
          group: "Remote branches",
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
        label: `Open ${recent.name}`,
        detail: recent.path,
        group: "Recent repositories",
        dynamic: true,
        run: () => void git.openPath(recent.path, recent.vcs ? asVcs(recent.vcs) : undefined),
      });
    }
    return list;
  }, [activeTabId, git, p4, perforceOpen, prefs, recents, repoOpen, setOpenPanel, snapshot, tabs]);

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
        <DialogTitle className="sr-only">Command palette</DialogTitle>
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
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) {
      const quiet = new Map<string, number>();
      return commands.filter((command) => {
        if (!command.dynamic) return true;
        const shown = quiet.get(command.group) ?? 0;
        if (command.group === "Remote branches" || shown >= QUIET_LIMIT) return false;
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
  }, [commands, query]);
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
          placeholder="Type a command, branch, or repository"
          aria-label="Command"
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
      <div role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1">
        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matching commands</p>
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
