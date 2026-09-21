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
import { defaultPrefs, normalizePrefs } from "@/lib/prefs";
import type {
  Activity,
  AppPrefs,
  AppSession,
  CommitDetails,
  CommitSummary,
  FileDiff,
  RecentRepo,
  Selection,
  StashInfo,
  WorkspaceSnapshot,
} from "@/types/git";

export type View = "changes" | "history" | "stash";
export const WELCOME_TAB_ID = "welcome";
export const COMMIT_PAGE = 80;

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
  commitsLoaded: boolean;
  commitsHasMore: boolean;
  commitsLoading: boolean;
  view: View;
  changeSelection: ChangeSelection | null;
  historySelection: HistorySelection | null;
  changeDiff: FileDiff | null;
  historyDiff: FileDiff | null;
  commitDetails: CommitDetails | null;
}

function repoTabId(path: string): string {
  return `repo:${path}`;
}

function emptySession(path: string): RepoSession {
  return {
    path,
    snapshot: null,
    commits: [],
    commitsLoaded: false,
    commitsHasMore: true,
    commitsLoading: false,
    view: "changes",
    changeSelection: null,
    historySelection: null,
    changeDiff: null,
    historyDiff: null,
    commitDetails: null,
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

function reorderAppTabs(
  tabs: AppTab[],
  fromId: string,
  toId: string,
  place: "before" | "after",
): AppTab[] {
  const from = tabs.findIndex((tab) => tab.id === fromId);
  if (from < 0) return tabs;
  const next = [...tabs];
  const [item] = next.splice(from, 1);
  let insert = next.findIndex((tab) => tab.id === toId);
  if (insert < 0) return tabs;
  if (place === "after") insert += 1;
  next.splice(insert, 0, item);
  const unchanged =
    next.length === tabs.length && next.every((tab, index) => tab.id === tabs[index].id);
  return unchanged ? tabs : next;
}

interface GitContextValue {
  recents: RecentRepo[];
  tabs: AppTab[];
  activeTabId: string;
  activeTab: AppTab;
  snapshot: WorkspaceSnapshot | null;
  commits: CommitSummary[];
  commitsHasMore: boolean;
  commitsLoading: boolean;
  view: View;
  changeSelection: ChangeSelection | null;
  historySelection: HistorySelection | null;
  changeDiff: FileDiff | null;
  historyDiff: FileDiff | null;
  commitDetails: CommitDetails | null;
  stashes: StashInfo[];
  activities: Activity[];
  prefs: AppPrefs;
  loading: boolean;
  busy: boolean;
  setView: (view: View) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (fromId: string, toId: string, place: "before" | "after") => void;
  openFolder: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  revealRepo: () => Promise<void>;
  openTerminal: () => Promise<void>;
  ensureBranches: () => Promise<void>;
  ensureHistory: () => Promise<void>;
  loadMoreCommits: () => Promise<void>;
  forgetRecent: (path: string) => Promise<void>;
  closeRepo: () => void;
  selectChange: (path: string, staged: boolean) => Promise<void>;
  selectCommit: (id: string) => Promise<void>;
  selectCommitFile: (id: string, path: string) => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (message: string, amend?: boolean) => Promise<void>;
  checkoutBranch: (name: string) => Promise<void>;
  fetchRemote: () => Promise<void>;
  pullRemote: () => Promise<void>;
  pushRemote: () => Promise<void>;
  createBranch: (name: string, switchTo: boolean) => Promise<void>;
  stashSave: (message: string, includeUntracked: boolean) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashPop: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  updatePrefs: (prefs: AppPrefs) => Promise<AppPrefs>;
}

const GitContext = createContext<GitContextValue | null>(null);

export function GitProvider({ children }: { children: ReactNode }) {
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [tabs, setTabs] = useState<AppTab[]>([{ id: WELCOME_TAB_ID, kind: "welcome" }]);
  const [activeTabId, setActiveTabId] = useState(WELCOME_TAB_ID);
  const [sessions, setSessions] = useState<Record<string, RepoSession>>({});
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [prefs, setPrefs] = useState<AppPrefs>(defaultPrefs);
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
        const next = { ...current, [tabId]: { ...existing, ...patch } };
        sessionsRef.current = next;
        return next;
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
        nextTabs.push(tab);
        nextSessions[tab.id] = { ...emptySession(snapshot.repo.path), snapshot };
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
        const [recentsList, session, loadedPrefs] = await Promise.all([
          gitApi.listRecents(),
          gitApi.loadSession(),
          gitApi.getPrefs().catch(() => defaultPrefs),
        ]);
        setPrefs(normalizePrefs(loadedPrefs));
        setRecents(recentsList);
        await restoreSession(session);
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

  const runActivity = useCallback(
    async <T,>(
      label: string,
      detail: string | undefined,
      fn: (activityId: string) => Promise<T>,
    ) => {
      const id = crypto.randomUUID();
      setActivities((current) => [...current, { id, label, detail }]);
      try {
        return await fn(id);
      } finally {
        setActivities((current) => current.filter((item) => item.id !== id));
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; line: string }>("git-progress", (event) => {
      setActivities((current) =>
        current.map((item) =>
          item.id === event.payload.id ? { ...item, detail: event.payload.line } : item,
        ),
      );
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
      const snapshot = await runActivity("Opening repository", path, () =>
        gitApi.openRepository(path),
      );
      const opened = findRepoTab(tabsRef.current, snapshot.repo.path);
      if (opened) {
        setActiveTabId(opened.id);
        setRecents(await gitApi.listRecents());
        return;
      }

      const tab = tabFromSnapshot(snapshot);
      setSessions((current) => ({
        ...current,
        [tab.id]: { ...emptySession(snapshot.repo.path), snapshot },
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
  }, [runActivity]);

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

  const reorderTabs = useCallback((fromId: string, toId: string, place: "before" | "after") => {
    setTabs((current) => reorderAppTabs(current, fromId, toId, place));
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

  const openTerminal = useCallback(async () => {
    const path = activeRepoPath();
    if (!path) return;
    try {
      await gitApi.openInTerminal(path);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [activeRepoPath]);

  const ensureBranches = useCallback(async () => {
    const repoPath = activeRepoPath();
    const tabId = activeTabIdRef.current;
    const current = sessionsRef.current[tabId];
    if (!repoPath || !current?.snapshot) return;
    if (current.snapshot.branches.remote.length > 0) return;
    try {
      const branches = await gitApi.getBranches(repoPath);
      const snapshot = sessionsRef.current[tabId]?.snapshot;
      if (!snapshot) return;
      patchSession(tabId, { snapshot: { ...snapshot, branches } });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [activeRepoPath, patchSession]);

  const historyInflightRef = useRef(new Set<string>());

  const ensureHistory = useCallback(async () => {
    const repoPath = activeRepoPath();
    const tabId = activeTabIdRef.current;
    const current = sessionsRef.current[tabId];
    if (!repoPath || !current || current.commitsLoaded || current.commitsLoading) return;
    if (historyInflightRef.current.has(tabId)) return;
    historyInflightRef.current.add(tabId);
    patchSession(tabId, { commitsLoading: true });
    try {
      const commits = await runActivity("Loading history", current.snapshot?.repo.name, () =>
        gitApi.getCommits(repoPath, COMMIT_PAGE, 0),
      );
      patchSession(tabId, {
        commits,
        commitsLoaded: true,
        commitsHasMore: commits.length === COMMIT_PAGE,
        commitsLoading: false,
      });
    } catch (error) {
      patchSession(tabId, { commitsLoading: false });
      toast.error(errorMessage(error));
    } finally {
      historyInflightRef.current.delete(tabId);
    }
  }, [activeRepoPath, patchSession, runActivity]);

  const loadMoreCommits = useCallback(async () => {
    const repoPath = activeRepoPath();
    const tabId = activeTabIdRef.current;
    const current = sessionsRef.current[tabId];
    if (!repoPath || !current || !current.commitsLoaded || current.commitsLoading || !current.commitsHasMore) {
      return;
    }
    patchSession(tabId, { commitsLoading: true });
    try {
      const more = await runActivity("Loading earlier history", current.snapshot?.repo.name, () =>
        gitApi.getCommits(repoPath, COMMIT_PAGE, current.commits.length),
      );
      patchSession(tabId, {
        commits: [...current.commits, ...more],
        commitsHasMore: more.length === COMMIT_PAGE,
        commitsLoading: false,
      });
    } catch (error) {
      patchSession(tabId, { commitsLoading: false });
      toast.error(errorMessage(error));
    }
  }, [activeRepoPath, patchSession, runActivity]);

  const refreshRepo = useCallback(
    async (path: string) => {
      const tab = findRepoTab(tabsRef.current, path);
      if (!tab) return;
      const current = sessionsRef.current[tab.id];
      try {
        const snapshot = await gitApi.refreshWorkspace(path);
        const headChanged = current?.snapshot?.repo.headId !== snapshot.repo.headId;
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
        patchSession(tab.id, {
          snapshot,
          changeDiff,
          historyDiff,
          ...(headChanged
            ? {
                commits: [],
                commitsLoaded: false,
                commitsHasMore: true,
                historySelection: null,
                historyDiff: null,
                commitDetails: null,
              }
            : {}),
        });
        if (headChanged && current?.view === "history") {
          const commits = await gitApi.getCommits(path, COMMIT_PAGE, 0);
          patchSession(tab.id, {
            commits,
            commitsLoaded: true,
            commitsHasMore: commits.length === COMMIT_PAGE,
          });
        }
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
          historyDiff: first?.binary ? emptyBinaryDiff(first.path, first.oldPath) : null,
        });
        if (first && !first.binary) {
          const historyDiff = await gitApi.getCommitDiff(repoPath, id, first.path);
          const selected = sessionsRef.current[tabId]?.historySelection;
          if (selected?.id === id && (selected.path ?? first.path) === first.path) {
            patchSession(tabId, { historyDiff });
          }
        }
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
    async (
      label: string,
      action: (repoPath: string, activityId: string) => Promise<WorkspaceSnapshot>,
      success?: string,
    ) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const current = sessionsRef.current[tabId];
      const changeSelection = current?.changeSelection ?? null;
      try {
        const next = await runActivity(label, current?.snapshot?.repo.name, async (activityId) => {
          const snapshot = await action(repoPath, activityId);
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
          const headChanged = current?.snapshot?.repo.headId !== snapshot.repo.headId;
          return { snapshot, changeDiff, changeSelection: nextSelection, headChanged };
        });
        patchSession(tabId, {
          snapshot: next.snapshot,
          changeDiff: next.changeDiff,
          changeSelection: next.changeSelection,
          ...(next.headChanged
            ? {
                commits: [],
                commitsLoaded: false,
                commitsHasMore: true,
              }
            : {}),
        });
        if (next.headChanged && sessionsRef.current[tabId]?.view === "history") {
          void ensureHistory();
        }
        if (success) toast.success(success);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [activeRepoPath, ensureHistory, patchSession, runActivity],
  );

  const stage = useCallback(
    async (paths: string[]) => {
      await runMutation("Staging files", (repoPath) => gitApi.stagePaths(repoPath, paths));
    },
    [runMutation],
  );

  const unstage = useCallback(
    async (paths: string[]) => {
      await runMutation("Unstaging files", (repoPath) => gitApi.unstagePaths(repoPath, paths));
    },
    [runMutation],
  );

  const discard = useCallback(
    async (paths: string[]) => {
      await runMutation(
        "Discarding changes",
        (repoPath) => gitApi.discardPaths(repoPath, paths),
        "Discarded changes",
      );
      const tabId = activeTabIdRef.current;
      const selected = sessionsRef.current[tabId]?.changeSelection;
      if (selected && paths.includes(selected.path)) {
        patchSession(tabId, { changeSelection: null, changeDiff: null });
      }
    },
    [patchSession, runMutation],
  );

  const commit = useCallback(
    async (message: string, amend = false) => {
      await runMutation(
        amend ? "Amending commit" : "Creating commit",
        (repoPath) => gitApi.commit(repoPath, message, amend),
        amend ? "Amended commit" : "Created commit",
      );
      patchSession(activeTabIdRef.current, { changeSelection: null, changeDiff: null });
    },
    [patchSession, runMutation],
  );

  const checkoutBranch = useCallback(
    async (name: string) => {
      await runMutation(
        `Checking out ${name}`,
        (repoPath) => gitApi.checkoutBranch(repoPath, name),
        `Checked out ${name}`,
      );
      patchSession(activeTabIdRef.current, {
        changeSelection: null,
        historySelection: null,
        changeDiff: null,
        historyDiff: null,
        commitDetails: null,
        commits: [],
        commitsLoaded: false,
        commitsHasMore: true,
      });
      if (sessionsRef.current[activeTabIdRef.current]?.view === "history") {
        void ensureHistory();
      }
    },
    [ensureHistory, patchSession, runMutation],
  );

  const fetchRemote = useCallback(async () => {
    await runMutation(
      "Fetching",
      (repoPath, activityId) => gitApi.fetchRemote(repoPath, activityId),
      "Fetched",
    );
  }, [runMutation]);

  const pullRemote = useCallback(async () => {
    await runMutation(
      "Pulling",
      (repoPath, activityId) => gitApi.pullRemote(repoPath, activityId),
      "Pulled",
    );
  }, [runMutation]);

  const pushRemote = useCallback(async () => {
    await runMutation(
      "Pushing",
      (repoPath, activityId) => gitApi.pushRemote(repoPath, activityId),
      "Pushed",
    );
  }, [runMutation]);

  const createBranch = useCallback(
    async (name: string, switchTo: boolean) => {
      await runMutation(
        switchTo ? `Creating and checking out ${name}` : `Creating ${name}`,
        (repoPath) => gitApi.createBranch(repoPath, name, switchTo),
        switchTo ? `Created and checked out ${name}` : `Created ${name}`,
      );
    },
    [runMutation],
  );

  const stashSave = useCallback(
    async (message: string, includeUntracked: boolean) => {
      await runMutation(
        "Saving stash",
        (repoPath) => gitApi.stashSave(repoPath, message, includeUntracked),
        "Saved stash",
      );
    },
    [runMutation],
  );

  const stashApply = useCallback(
    async (index: number) => {
      await runMutation(
        "Applying stash",
        (repoPath) => gitApi.stashApply(repoPath, index),
        "Applied stash",
      );
    },
    [runMutation],
  );

  const stashPop = useCallback(
    async (index: number) => {
      await runMutation("Popping stash", (repoPath) => gitApi.stashPop(repoPath, index), "Popped stash");
    },
    [runMutation],
  );

  const stashDrop = useCallback(
    async (index: number) => {
      await runMutation("Dropping stash", (repoPath) => gitApi.stashDrop(repoPath, index), "Dropped stash");
    },
    [runMutation],
  );

  const updatePrefs = useCallback(async (next: AppPrefs) => {
    const saved = normalizePrefs(await gitApi.setPrefs(next));
    setPrefs(saved);
    return saved;
  }, []);

  const value = useMemo<GitContextValue>(
    () => ({
      recents,
      tabs,
      activeTabId,
      activeTab,
      snapshot: session?.snapshot ?? null,
      commits: session?.commits ?? [],
      commitsHasMore: session?.commitsHasMore ?? true,
      commitsLoading: session?.commitsLoading ?? false,
      view: session?.view ?? "changes",
      changeSelection: session?.changeSelection ?? null,
      historySelection: session?.historySelection ?? null,
      changeDiff: session?.changeDiff ?? null,
      historyDiff: session?.historyDiff ?? null,
      commitDetails: session?.commitDetails ?? null,
      stashes: session?.snapshot?.stashes ?? [],
      activities,
      prefs,
      loading,
      busy: opening || activities.length > 0,
      setView,
      setActiveTab: setActiveTabId,
      closeTab,
      reorderTabs,
      openFolder,
      openPath,
      revealRepo,
      openTerminal,
      ensureBranches,
      ensureHistory,
      loadMoreCommits,
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
      fetchRemote,
      pullRemote,
      pushRemote,
      createBranch,
      stashSave,
      stashApply,
      stashPop,
      stashDrop,
      updatePrefs,
    }),
    [
      recents,
      tabs,
      activeTabId,
      activeTab,
      session,
      activities,
      prefs,
      loading,
      opening,
      setView,
      closeTab,
      reorderTabs,
      openFolder,
      openPath,
      revealRepo,
      openTerminal,
      ensureBranches,
      ensureHistory,
      loadMoreCommits,
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
      fetchRemote,
      pullRemote,
      pushRemote,
      createBranch,
      stashSave,
      stashApply,
      stashPop,
      stashDrop,
      updatePrefs,
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
