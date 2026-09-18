import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { emptyBinaryDiff, errorMessage, gitApi } from "@/lib/git";
import { sameRepoPath } from "@/lib/format";
import type {
  AppSession,
  CommitDetails,
  CommitSummary,
  FileDiff,
  RecentRepo,
  Selection,
  WorkspaceSnapshot,
} from "@/types/git";

export type View = "changes" | "history";
export const WELCOME_TAB_ID = "welcome";

export type WelcomeTab = { id: typeof WELCOME_TAB_ID; kind: "welcome" };
export type RepoTab = {
  id: string;
  kind: "repo";
  path: string;
  name: string;
  branch: string | null;
  isDetached: boolean;
};
export type AppTab = WelcomeTab | RepoTab;

type ChangeSelection = Extract<Selection, { type: "change" }>;
type HistorySelection = Extract<Selection, { type: "commit" }>;

interface RepoSession {
  path: string;
  snapshot: WorkspaceSnapshot | null;
  commits: CommitSummary[];
  view: View;
  changeSelection: ChangeSelection | null;
  historySelection: HistorySelection | null;
  changeDiff: FileDiff | null;
  historyDiff: FileDiff | null;
  commitDetails: CommitDetails | null;
  busy: boolean;
}

function repoTabId(path: string): string {
  return `repo:${path}`;
}

function emptySession(path: string): RepoSession {
  return {
    path,
    snapshot: null,
    commits: [],
    view: "changes",
    changeSelection: null,
    historySelection: null,
    changeDiff: null,
    historyDiff: null,
    commitDetails: null,
    busy: false,
  };
}

function tabFromSnapshot(snapshot: WorkspaceSnapshot): RepoTab {
  return {
    id: repoTabId(snapshot.repo.path),
    kind: "repo",
    path: snapshot.repo.path,
    name: snapshot.repo.name,
    branch: snapshot.repo.currentBranch,
    isDetached: snapshot.repo.isDetached,
  };
}

function findRepoTab(tabs: AppTab[], path: string): RepoTab | undefined {
  return tabs.find(
    (tab): tab is RepoTab => tab.kind === "repo" && sameRepoPath(tab.path, path),
  );
}

interface GitContextValue {
  recents: RecentRepo[];
  tabs: AppTab[];
  activeTabId: string;
  activeTab: AppTab;
  snapshot: WorkspaceSnapshot | null;
  commits: CommitSummary[];
  view: View;
  changeSelection: ChangeSelection | null;
  historySelection: HistorySelection | null;
  changeDiff: FileDiff | null;
  historyDiff: FileDiff | null;
  commitDetails: CommitDetails | null;
  loading: boolean;
  busy: boolean;
  setView: (view: View) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  openFolder: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  revealRepo: () => Promise<void>;
  forgetRecent: (path: string) => Promise<void>;
  closeRepo: () => void;
  selectChange: (path: string, staged: boolean) => Promise<void>;
  selectCommit: (id: string) => Promise<void>;
  selectCommitFile: (id: string, path: string) => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<void>;
  checkoutBranch: (name: string) => Promise<void>;
  createBranch: (name: string, switchTo: boolean) => Promise<void>;
}

const GitContext = createContext<GitContextValue | null>(null);

export function GitProvider({ children }: { children: ReactNode }) {
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [tabs, setTabs] = useState<AppTab[]>([{ id: WELCOME_TAB_ID, kind: "welcome" }]);
  const [activeTabId, setActiveTabId] = useState(WELCOME_TAB_ID);
  const [sessions, setSessions] = useState<Record<string, RepoSession>>({});
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const restoredRef = useRef(false);

  const tabsRef = useRef(tabs);
  const sessionsRef = useRef(sessions);
  const activeTabIdRef = useRef(activeTabId);
  const openingPathsRef = useRef(new Set<string>());
  tabsRef.current = tabs;
  sessionsRef.current = sessions;
  activeTabIdRef.current = activeTabId;

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const session = activeTab.kind === "repo" ? sessions[activeTab.id] : undefined;

  const syncTabMeta = useCallback((tabId: string, snapshot: WorkspaceSnapshot) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId && tab.kind === "repo"
          ? {
              ...tab,
              path: snapshot.repo.path,
              name: snapshot.repo.name,
              branch: snapshot.repo.currentBranch,
              isDetached: snapshot.repo.isDetached,
            }
          : tab,
      ),
    );
  }, []);

  const patchSession = useCallback(
    (tabId: string, patch: Partial<RepoSession>) => {
      setSessions((current) => {
        const existing = current[tabId];
        if (!existing) return current;
        return { ...current, [tabId]: { ...existing, ...patch } };
      });
      if (patch.snapshot) syncTabMeta(tabId, patch.snapshot);
    },
    [syncTabMeta],
  );

  const activeRepoPath = useCallback(() => {
    const tab = tabsRef.current.find((item) => item.id === activeTabIdRef.current);
    return tab?.kind === "repo" ? tab.path : null;
  }, []);

  const persistSession = useCallback((nextTabs: AppTab[], nextActiveId: string) => {
    const openPaths = nextTabs
      .filter((tab): tab is RepoTab => tab.kind === "repo")
      .map((tab) => tab.path);
    const activeTab = nextTabs.find((tab) => tab.id === nextActiveId);
    const active = activeTab?.kind === "repo" ? activeTab.path : "welcome";
    void gitApi.saveSession({ openPaths, active }).catch(() => undefined);
  }, []);

  const restoreSession = useCallback(async (session: AppSession) => {
    const nextTabs: AppTab[] = [{ id: WELCOME_TAB_ID, kind: "welcome" }];
    const nextSessions: Record<string, RepoSession> = {};
    let activeId = WELCOME_TAB_ID;

    for (const path of session.openPaths) {
      try {
        const snapshot = await gitApi.openRepository(path);
        const tab = tabFromSnapshot(snapshot);
        if (nextTabs.some((item) => item.id === tab.id)) continue;
        const commits = await gitApi.getCommits(snapshot.repo.path, 120);
        nextTabs.push(tab);
        nextSessions[tab.id] = { ...emptySession(snapshot.repo.path), snapshot, commits };
        if (session.active !== "welcome" && sameRepoPath(session.active, snapshot.repo.path)) {
          activeId = tab.id;
        }
      } catch {
        // Skip folders that disappeared since the last session.
      }
    }

    if (session.active !== "welcome" && activeId === WELCOME_TAB_ID) {
      const fallback = nextTabs.find((tab): tab is RepoTab => tab.kind === "repo");
      if (fallback) activeId = fallback.id;
    }

    setSessions(nextSessions);
    setTabs(nextTabs);
    setActiveTabId(activeId);
    setRecents(await gitApi.listRecents());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setRecents(await gitApi.listRecents());
        await restoreSession(await gitApi.loadSession());
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        restoredRef.current = true;
        setLoading(false);
      }
    })();
  }, [restoreSession]);

  useEffect(() => {
    if (!restoredRef.current) return;
    persistSession(tabs, activeTabId);
  }, [activeTabId, persistSession, tabs]);

  const openPath = useCallback(async (path: string) => {
    const existing = findRepoTab(tabsRef.current, path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const pendingKey = path.toLowerCase();
    if (openingPathsRef.current.has(pendingKey)) return;
    openingPathsRef.current.add(pendingKey);
    setOpening(true);
    try {
      const snapshot = await gitApi.openRepository(path);
      const opened = findRepoTab(tabsRef.current, snapshot.repo.path);
      if (opened) {
        setActiveTabId(opened.id);
        setRecents(await gitApi.listRecents());
        return;
      }

      const tab = tabFromSnapshot(snapshot);
      const commits = await gitApi.getCommits(snapshot.repo.path, 120);
      setSessions((current) => ({
        ...current,
        [tab.id]: { ...emptySession(snapshot.repo.path), snapshot, commits },
      }));
      setTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
      setActiveTabId(tab.id);
      setRecents(await gitApi.listRecents());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      openingPathsRef.current.delete(pendingKey);
      setOpening(openingPathsRef.current.size > 0);
    }
  }, []);

  const openFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Git repository",
    });
    if (typeof selected === "string") {
      await openPath(selected);
    }
  }, [openPath]);

  const forgetRecent = useCallback(async (path: string) => {
    try {
      setRecents(await gitApi.forgetRecent(path));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  const closeTab = useCallback((id: string) => {
    if (id === WELCOME_TAB_ID) return;
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      setActiveTabId((active) => {
        if (active !== id) return active;
        return next[Math.max(0, index - 1)]?.id ?? WELCOME_TAB_ID;
      });
      return next.length > 0 ? next : [{ id: WELCOME_TAB_ID, kind: "welcome" }];
    });
    setSessions((current) => {
      const { [id]: _dropped, ...rest } = current;
      return rest;
    });
  }, []);

  const closeRepo = useCallback(() => {
    const tab = tabsRef.current.find((item) => item.id === activeTabIdRef.current);
    if (tab?.kind === "repo") closeTab(tab.id);
  }, [closeTab]);

  const revealRepo = useCallback(async () => {
    const path = activeRepoPath();
    if (!path) return;
    try {
      await gitApi.openInFileManager(path);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [activeRepoPath]);

  const refreshRepo = useCallback(
    async (path: string) => {
      const tab = findRepoTab(tabsRef.current, path);
      if (!tab) return;
      const current = sessionsRef.current[tab.id];
      try {
        const [snapshot, commits] = await Promise.all([
          gitApi.refreshWorkspace(path),
          gitApi.getCommits(path, 120),
        ]);
        let changeDiff = current?.changeDiff ?? null;
        let historyDiff = current?.historyDiff ?? null;
        if (current?.changeSelection) {
          try {
            changeDiff = await gitApi.getWorkdirDiff(
              path,
              current.changeSelection.path,
              current.changeSelection.staged,
            );
          } catch {
            changeDiff = null;
          }
        }
        if (current?.historySelection?.path) {
          try {
            historyDiff = await gitApi.getCommitDiff(
              path,
              current.historySelection.id,
              current.historySelection.path,
            );
          } catch {
            historyDiff = null;
          }
        }
        patchSession(tab.id, { snapshot, commits, changeDiff, historyDiff });
      } catch {
        // Watch refreshes stay quiet when a repo is mid-write.
      }
    },
    [patchSession],
  );

  useEffect(() => {
    const paths = tabs.filter((tab): tab is RepoTab => tab.kind === "repo").map((tab) => tab.path);
    void gitApi.syncWatches(paths).catch(() => undefined);
  }, [tabs]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("repo-changed", (event) => {
      void refreshRepo(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshRepo]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openFolder();
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        closeRepo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeRepo, openFolder]);

  const setView = useCallback(
    (view: View) => {
      patchSession(activeTabIdRef.current, { view });
    },
    [patchSession],
  );

  const selectChange = useCallback(
    async (path: string, staged: boolean) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      patchSession(tabId, { view: "changes", changeSelection: { type: "change", path, staged } });
      try {
        patchSession(tabId, { changeDiff: await gitApi.getWorkdirDiff(repoPath, path, staged) });
      } catch (error) {
        patchSession(tabId, { changeDiff: null });
        toast.error(errorMessage(error));
      }
    },
    [activeRepoPath, patchSession],
  );

  const selectCommit = useCallback(
    async (id: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      patchSession(tabId, { view: "history", historySelection: { type: "commit", id } });
      try {
        const details = await gitApi.getCommitDetails(repoPath, id);
        const first = details.files[0];
        patchSession(tabId, {
          commitDetails: details,
          historySelection: first ? { type: "commit", id, path: first.path } : { type: "commit", id },
          historyDiff: first
            ? first.binary
              ? emptyBinaryDiff(first.path, first.oldPath)
              : await gitApi.getCommitDiff(repoPath, id, first.path)
            : null,
        });
      } catch (error) {
        patchSession(tabId, { commitDetails: null, historyDiff: null });
        toast.error(errorMessage(error));
      }
    },
    [activeRepoPath, patchSession],
  );

  const selectCommitFile = useCallback(
    async (id: string, path: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      patchSession(tabId, { view: "history", historySelection: { type: "commit", id, path } });
      try {
        const current = sessionsRef.current[tabId];
        const details =
          current?.commitDetails?.commit.id === id
            ? current.commitDetails
            : await gitApi.getCommitDetails(repoPath, id);
        const file = details.files.find((item) => item.path === path);
        patchSession(tabId, {
          commitDetails: details,
          historyDiff: file?.binary
            ? emptyBinaryDiff(path, file.oldPath)
            : await gitApi.getCommitDiff(repoPath, id, path),
        });
      } catch (error) {
        patchSession(tabId, { historyDiff: null });
        toast.error(errorMessage(error));
      }
    },
    [activeRepoPath, patchSession],
  );

  const runMutation = useCallback(
    async (action: (repoPath: string) => Promise<WorkspaceSnapshot>, success?: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const current = sessionsRef.current[tabId];
      const changeSelection = current?.changeSelection ?? null;
      patchSession(tabId, { busy: true });
      try {
        const snapshot = await action(repoPath);
        const commits = await gitApi.getCommits(repoPath, 120);
        let changeDiff = current?.changeDiff ?? null;
        let nextSelection = changeSelection;
        if (changeSelection) {
          try {
            changeDiff = await gitApi.getWorkdirDiff(
              repoPath,
              changeSelection.path,
              changeSelection.staged,
            );
          } catch {
            changeDiff = null;
            nextSelection = null;
          }
        }
        patchSession(tabId, {
          snapshot,
          commits,
          changeDiff,
          changeSelection: nextSelection,
          busy: false,
        });
        if (success) toast.success(success);
      } catch (error) {
        patchSession(tabId, { busy: false });
        toast.error(errorMessage(error));
      }
    },
    [activeRepoPath, patchSession],
  );

  const stage = useCallback(
    async (paths: string[]) => {
      await runMutation((repoPath) => gitApi.stagePaths(repoPath, paths));
    },
    [runMutation],
  );

  const unstage = useCallback(
    async (paths: string[]) => {
      await runMutation((repoPath) => gitApi.unstagePaths(repoPath, paths));
    },
    [runMutation],
  );

  const discard = useCallback(
    async (paths: string[]) => {
      await runMutation((repoPath) => gitApi.discardPaths(repoPath, paths), "Discarded changes");
      const tabId = activeTabIdRef.current;
      const selected = sessionsRef.current[tabId]?.changeSelection;
      if (selected && paths.includes(selected.path)) {
        patchSession(tabId, { changeSelection: null, changeDiff: null });
      }
    },
    [patchSession, runMutation],
  );

  const commit = useCallback(
    async (message: string) => {
      await runMutation((repoPath) => gitApi.commit(repoPath, message), "Created commit");
      patchSession(activeTabIdRef.current, { changeSelection: null, changeDiff: null });
    },
    [patchSession, runMutation],
  );

  const checkoutBranch = useCallback(
    async (name: string) => {
      await runMutation((repoPath) => gitApi.checkoutBranch(repoPath, name), `Checked out ${name}`);
      patchSession(activeTabIdRef.current, {
        changeSelection: null,
        historySelection: null,
        changeDiff: null,
        historyDiff: null,
        commitDetails: null,
      });
    },
    [patchSession, runMutation],
  );

  const createBranch = useCallback(
    async (name: string, switchTo: boolean) => {
      await runMutation(
        (repoPath) => gitApi.createBranch(repoPath, name, switchTo),
        switchTo ? `Created and checked out ${name}` : `Created ${name}`,
      );
    },
    [runMutation],
  );

  const value = useMemo<GitContextValue>(
    () => ({
      recents,
      tabs,
      activeTabId,
      activeTab,
      snapshot: session?.snapshot ?? null,
      commits: session?.commits ?? [],
      view: session?.view ?? "changes",
      changeSelection: session?.changeSelection ?? null,
      historySelection: session?.historySelection ?? null,
      changeDiff: session?.changeDiff ?? null,
      historyDiff: session?.historyDiff ?? null,
      commitDetails: session?.commitDetails ?? null,
      loading,
      busy: opening || (session?.busy ?? false),
      setView,
      setActiveTab: setActiveTabId,
      closeTab,
      openFolder,
      openPath,
      revealRepo,
      forgetRecent,
      closeRepo,
      selectChange,
      selectCommit,
      selectCommitFile,
      stage,
      unstage,
      discard,
      commit,
      checkoutBranch,
      createBranch,
    }),
    [
      recents,
      tabs,
      activeTabId,
      activeTab,
      session,
      loading,
      opening,
      setView,
      closeTab,
      openFolder,
      openPath,
      revealRepo,
      forgetRecent,
      closeRepo,
      selectChange,
      selectCommit,
      selectCommitFile,
      stage,
      unstage,
      discard,
      commit,
      checkoutBranch,
      createBranch,
    ],
  );

  return <GitContext.Provider value={value}>{children}</GitContext.Provider>;
}

export function useGit() {
  const value = useContext(GitContext);
  if (!value) {
    throw new Error("useGit must be used within GitProvider");
  }
  return value;
}
