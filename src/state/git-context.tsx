import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { emptyBinaryDiff, errorMessage, expandHistoryRevs, GIT_MISSING, gitApi, isCancelled, subscribeGitMissing } from "@/lib/git";
import { normalizeRepoPath, sameRepoPath } from "@/lib/format";
import { defaultPrefs, normalizePrefs, sameLayout } from "@/lib/prefs";
import {
  COMMIT_PAGE,
  WELCOME_TAB_ID,
  defaultFetchRemote,
  emptySession,
  findRepoTab,
  lookupHistoryRevs,
  lookupPathList,
  primaryRemote,
  reorderAppTabs,
  tabFromPath,
  tabFromSnapshot,
  type AppTab,
  type ChangeSelection,
  type CommitDraft,
  type FileFocus,
  type HistorySelection,
  type PublishPrompt,
  type RepoSession,
  type RepoTab,
  type ResetMode,
  type StashSelection,
  type View,
} from "@/state/session";
import {
  historyGraphChanged,
  keepRemoteBranches,
  mergeRefreshHint,
  progressFromGitLine,
  sameDiff,
  sameRevs,
  sameSnapshot,
  shouldReloadWorkdirDiff,
  type RefreshHint,
} from "@/state/snapshot-compare";
import type {
  Activity,
  AppPrefs,
  AppSession,
  PanelLayout,
  PanelLayoutId,
  CommitDetails,
  CommitSummary,
  CompareRevision,
  RevisionComparison,
  FileDiff,
  FileSource,
  LineAction,
  LineRef,
  RecentRepo,
  RebaseStep,
  StashDetails,
  StashInfo,
  WorkspaceSnapshot,
} from "@/types/git";

export { COMMIT_PAGE, WELCOME_TAB_ID, defaultFetchRemote, primaryRemote };
export type Panel = "reflog" | "palette" | "settings" | "new-branch";
export type { AppTab, PublishPrompt, RepoTab, ResetMode, StashSelection, View };

function afterPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
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
  historyRevs: string[];
  historyExpanded: string[] | null;
  view: View;
  changeSelection: ChangeSelection | null;
  historySelection: HistorySelection | null;
  changeDiff: FileDiff | null;
  historyDiff: FileDiff | null;
  commitDetails: CommitDetails | null;
  comparison: RevisionComparison | null;
  stashSelection: StashSelection | null;
  stashDetails: StashDetails | null;
  stashDiff: FileDiff | null;
  stashes: StashInfo[];
  fileFocus: FileFocus | null;
  commitDraft: CommitDraft | null;
  /** An app-wide overlay that any view or the command palette can open. */
  openPanel: Panel | null;
  prefs: AppPrefs;
  /** No usable Git executable is selected. */
  gitMissing: boolean;
  loading: boolean;
  setOpenPanel: (panel: Panel | null) => void;
  setView: (view: View) => void;
  showFile: (path: string, mode: FileFocus["mode"]) => void;
  openRepoFile: (path: string) => Promise<void>;
  revealRepoFile: (path: string) => Promise<void>;
  /** Opens a repository file, or the repository itself without a path, in the chosen editor. */
  openInEditor: (path?: string, line?: number | null) => Promise<void>;
  openDifftool: (source: FileSource) => Promise<void>;
  runMergetool: (path: string) => Promise<boolean>;
  ignorePaths: (patterns: string[]) => Promise<boolean>;
  beginActivity: (label: string, detail?: string) => string;
  endActivity: (id: string) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (fromId: string, toId: string, place: "before" | "after") => void;
  openFolder: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  cloneRepository: (url: string, destination: string) => Promise<boolean>;
  revealRepo: () => Promise<void>;
  openTerminal: () => Promise<void>;
  ensureBranches: () => Promise<void>;
  ensureHistory: () => Promise<void>;
  loadMoreCommits: () => Promise<void>;
  setHistoryRevs: (revs: string[]) => void;
  setHistoryExpanded: (ids: string[]) => void;
  forgetRecent: (path: string) => Promise<void>;
  closeRepo: () => void;
  selectChange: (path: string, staged: boolean) => Promise<void>;
  selectCommit: (id: string) => Promise<void>;
  selectCommitFile: (id: string, path: string) => Promise<void>;
  openComparison: (base: CompareRevision, head: CompareRevision) => void;
  swapComparison: () => void;
  closeComparison: () => void;
  selectCompareFile: (path: string) => Promise<void>;
  selectStash: (stash: StashInfo) => Promise<void>;
  selectStashFile: (id: string, path: string) => Promise<void>;
  /** Clears the file open in a diff or the Files view's counterpart panes. */
  closeFile: (source: "changes" | "history" | "stash") => void;
  /** Clears the open stash, including its file list. */
  closeStash: () => void;
  /** Clears the open commit, including its file list. */
  closeCommit: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  applyLines: (path: string, staged: boolean, action: LineAction, lines: LineRef[]) => Promise<boolean>;
  commit: (message: string, amend?: boolean) => Promise<boolean>;
  undoLastCommit: () => Promise<boolean>;
  checkoutDetached: (oid: string) => Promise<boolean>;
  updateSubmodules: (paths: string[]) => Promise<boolean>;
  checkoutBranch: (name: string) => Promise<void>;
  fetchRemote: (remote?: string) => Promise<void>;
  fetchAllRemotes: () => Promise<void>;
  pullRemote: (remote?: string, rebase?: boolean) => Promise<void>;
  pushRemote: (options?: { remote?: string; force?: boolean; setUpstream?: boolean }) => Promise<boolean>;
  publishPrompt: PublishPrompt | null;
  dismissPublish: () => void;
  confirmPublish: () => Promise<void>;
  createBranch: (name: string, switchTo: boolean, start?: string) => Promise<boolean>;
  createTag: (name: string, message?: string, target?: string) => Promise<boolean>;
  deleteTag: (name: string) => Promise<boolean>;
  pushTag: (remote: string, name: string) => Promise<boolean>;
  deleteRemoteTag: (remote: string, name: string) => Promise<boolean>;
  deleteBranch: (name: string, force?: boolean) => Promise<boolean | "unmerged">;
  revertCommit: (oid: string) => Promise<boolean>;
  cherryPickCommit: (oid: string) => Promise<boolean>;
  rebaseOnto: (onto: string, label: string) => Promise<boolean>;
  rebaseInteractive: (onto: string, steps: RebaseStep[]) => Promise<boolean>;
  rebaseContinue: () => Promise<boolean>;
  rebaseSkip: () => Promise<boolean>;
  rebaseAbort: () => Promise<boolean>;
  mergeRef: (onto: string, label: string) => Promise<boolean>;
  operationContinue: (message?: string) => Promise<boolean>;
  operationAbort: () => Promise<boolean>;
  resolveConflict: (path: string, side: "ours" | "theirs" | "both") => Promise<boolean>;
  saveConflict: (path: string, text: string) => Promise<boolean>;
  resetCommit: (oid: string, mode: ResetMode) => Promise<boolean>;
  createPatch: (commit: CommitSummary) => Promise<void>;
  applyPatch: () => Promise<void>;
  addRemote: (name: string, url: string) => Promise<boolean>;
  deleteRemote: (name: string) => Promise<boolean>;
  stashSave: (message: string, includeUntracked: boolean, paths?: string[]) => Promise<boolean>;
  stashApply: (id: string) => Promise<void>;
  stashPop: (id: string) => Promise<void>;
  stashDrop: (id: string) => Promise<void>;
  updatePrefs: (prefs: AppPrefs) => Promise<AppPrefs>;
  setDiffOptions: (options: { split?: boolean; ignoreWhitespace?: boolean }) => Promise<void>;
  updatePanelLayout: (id: PanelLayoutId, layout: PanelLayout) => void;
}

type ActionKey = {
  [K in keyof GitContextValue]: GitContextValue[K] extends (...args: never[]) => unknown ? K : never;
}[keyof GitContextValue];
type GitActions = Pick<GitContextValue, ActionKey>;
type GitState = Omit<GitContextValue, ActionKey>;

interface GitStore {
  get: () => GitState;
  set: (next: GitState) => void;
  subscribe: (listener: () => void) => () => void;
}

function createStore(initial: GitState): GitStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const OPERATION_FINISHED: Record<string, string> = {
  merge: "Merge finished",
  rebase: "Rebase finished",
  "cherry-pick": "Cherry-pick finished",
  revert: "Revert finished",
};

const OPEN_SETTINGS_EVENT = "rebasely-open-settings";

function reportError(error: unknown) {
  const message = errorMessage(error);
  if (message === GIT_MISSING) {
    toast.error(message, {
      id: "git-missing",
      action: {
        label: "Settings",
        onClick: () => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT)),
      },
    });
    return;
  }
  toast.error(message);
}

const NO_COMMITS: CommitSummary[] = [];
const NO_REVS: string[] = [];
const NO_STASHES: StashInfo[] = [];

// The value never changes after mount; components subscribe to the store for
// the fields they read, so an unrelated update does not re-render them.
const GitContext = createContext<{ store: GitStore; actions: GitActions } | null>(null);
// Progress updates arrive many times per second; keeping them out of GitContext
// means only the activity meter re-renders for them.
const ActivityContext = createContext<Activity[]>([]);

export function GitProvider({ children }: { children: ReactNode }) {
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [tabs, setTabs] = useState<AppTab[]>([{ id: WELCOME_TAB_ID, kind: "welcome" }]);
  const [activeTabId, setActiveTabId] = useState(WELCOME_TAB_ID);
  const [sessions, setSessions] = useState<Record<string, RepoSession>>({});
  const [loading, setLoading] = useState(true);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [publishPrompt, setPublishPrompt] = useState<PublishPrompt | null>(null);
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const [prefs, setPrefs] = useState<AppPrefs>(defaultPrefs);
  const [gitMissing, setGitMissing] = useState(false);
  const restoredRef = useRef(false);
  const refreshAfterReplayRef = useRef<() => Promise<void>>(async () => {});
  const prefsRef = useRef(prefs);
  const persistPrefsTimer = useRef<number | null>(null);

  const tabsRef = useRef(tabs);
  const sessionsRef = useRef(sessions);
  const activeTabIdRef = useRef(activeTabId);
  const openingPathsRef = useRef(new Set<string>());
  const historyRevsMapRef = useRef<Record<string, string[]>>({});
  const historyExpandedMapRef = useRef<Record<string, string[]>>({});
  const historyLoadGen = useRef(0);
  const compareLoadGen = useRef(0);
  const stashLoadGen = useRef(0);
  const changeLoadGen = useRef(0);

  // The refs are the source of truth for callbacks. Every update is computed
  // from them and handed to React as a plain value, so a render that skips a
  // pending transition can never roll them back.
  const commitSessions = useCallback((next: Record<string, RepoSession>) => {
    sessionsRef.current = next;
    setSessions(next);
  }, []);
  const commitTabs = useCallback((next: AppTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);
  const commitActiveTabId = useCallback((next: string) => {
    activeTabIdRef.current = next;
    setActiveTabId(next);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const session = activeTab.kind === "repo" ? sessions[activeTab.id] : undefined;

  const syncTabMeta = useCallback(
    (tabId: string, snapshot: WorkspaceSnapshot) => {
      const current = tabsRef.current;
      const { path, name, currentBranch: branch, isDetached } = snapshot.repo;
      const index = current.findIndex((tab) => tab.id === tabId);
      const tab = current[index];
      if (!tab || tab.kind !== "repo") return;
      if (
        tab.path === path &&
        tab.name === name &&
        tab.branch === branch &&
        tab.isDetached === isDetached
      ) {
        return;
      }
      const next = [...current];
      next[index] = { ...tab, path, name, branch, isDetached };
      commitTabs(next);
    },
    [commitTabs],
  );

  const patchSession = useCallback(
    (
      tabId: string,
      patch: Partial<RepoSession>,
      generation?: number,
      scope: "history" | "stash" = "history",
    ) => {
      const active = scope === "stash" ? stashLoadGen.current : historyLoadGen.current;
      if (generation !== undefined && active !== generation) return;
      const current = sessionsRef.current;
      const existing = current[tabId];
      if (!existing) return;
      commitSessions({ ...current, [tabId]: { ...existing, ...patch } });
      if (patch.snapshot) syncTabMeta(tabId, patch.snapshot);
    },
    [commitSessions, syncTabMeta],
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
    const historyRevs = { ...historyRevsMapRef.current };
    const historyExpanded = { ...historyExpandedMapRef.current };
    for (const item of Object.values(sessionsRef.current)) {
      if (!item.path) continue;
      historyRevs[item.path] = item.historyRevs;
      if (item.historyExpanded !== null) historyExpanded[item.path] = item.historyExpanded;
    }
    historyRevsMapRef.current = historyRevs;
    historyExpandedMapRef.current = historyExpanded;
    void gitApi.saveSession({ openPaths, active, historyRevs, historyExpanded }).catch(() => undefined);
  }, []);

  const restoreSession = useCallback((session: AppSession, recentsList: RecentRepo[]) => {
    const nextTabs: AppTab[] = [{ id: WELCOME_TAB_ID, kind: "welcome" }];
    const nextSessions: Record<string, RepoSession> = {};
    let activeId = WELCOME_TAB_ID;
    const historyRevsMap = session.historyRevs ?? {};
    const historyExpandedMap = session.historyExpanded ?? {};
    historyRevsMapRef.current = historyRevsMap;
    historyExpandedMapRef.current = historyExpandedMap;

    for (const path of session.openPaths) {
      const recent = recentsList.find((item) => sameRepoPath(item.path, path));
      const tab = tabFromPath(path, recent?.name);
      if (nextTabs.some((item) => item.id === tab.id)) continue;
      nextTabs.push(tab);
      nextSessions[tab.id] = emptySession(
        path,
        lookupHistoryRevs(historyRevsMap, path),
        lookupPathList(historyExpandedMap, path),
      );
      if (session.active !== "welcome" && sameRepoPath(session.active, path)) {
        activeId = tab.id;
      }
    }

    if (session.active !== "welcome" && activeId === WELCOME_TAB_ID) {
      const fallback = nextTabs.find((tab): tab is RepoTab => tab.kind === "repo");
      if (fallback) activeId = fallback.id;
    }

    commitSessions(nextSessions);
    commitTabs(nextTabs);
    commitActiveTabId(activeId);
  }, [commitActiveTabId, commitSessions, commitTabs]);

  useEffect(() => {
    const unsubscribe = subscribeGitMissing(() => setGitMissing(true));
    const openSettings = () => setOpenPanel("settings");
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => {
      unsubscribe();
      window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
    };
  }, [setOpenPanel]);

  useEffect(() => {
    void (async () => {
      try {
        const [recentsList, session, loadedPrefs, executables] = await Promise.all([
          gitApi.listRecents(),
          gitApi.loadSession(),
          gitApi.getPrefs().catch(() => defaultPrefs),
          gitApi.gitExecutables().catch(() => null),
        ]);
        const nextPrefs = normalizePrefs(loadedPrefs);
        prefsRef.current = nextPrefs;
        setPrefs(nextPrefs);
        setRecents(recentsList);
        restoreSession(session, recentsList);
        if (executables) {
          const missing = executables.active === null;
          setGitMissing(missing);
          if (missing) reportError(GIT_MISSING);
        }
      } catch (error) {
        reportError(error);
      } finally {
        restoredRef.current = true;
        setLoading(false);
      }
    })();
  }, [restoreSession]);

  useEffect(() => {
    const flushPendingPrefs = () => {
      if (persistPrefsTimer.current === null) return;
      window.clearTimeout(persistPrefsTimer.current);
      persistPrefsTimer.current = null;
      void gitApi.setPrefs(prefsRef.current).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushPendingPrefs();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", flushPendingPrefs);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", flushPendingPrefs);
      flushPendingPrefs();
    };
  }, []);

  const persistKey = useMemo(() => {
    const open = tabs.filter((tab): tab is RepoTab => tab.kind === "repo").map((tab) => tab.path);
    return JSON.stringify([open, activeTabId]);
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (!restoredRef.current) return;
    persistSession(tabsRef.current, activeTabIdRef.current);
  }, [persistKey, persistSession]);

  const runActivity = useCallback(
    async <T,>(
      label: string,
      detail: string | undefined,
      fn: (activityId: string) => Promise<T>,
      cancellable = false,
    ) => {
      const id = crypto.randomUUID();
      setActivities((current) => [...current, { id, label, detail, cancellable }]);
      try {
        return await fn(id);
      } finally {
        setActivities((current) => current.filter((item) => item.id !== id));
      }
    },
    [],
  );

  const beginActivity = useCallback((label: string, detail?: string, progress?: number) => {
    const id = crypto.randomUUID();
    setActivities((current) => [...current, { id, label, detail, progress }]);
    return id;
  }, []);

  const patchActivity = useCallback(
    (id: string, patch: Partial<Pick<Activity, "label" | "detail" | "progress">>) => {
      setActivities((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const endActivity = useCallback((id: string) => {
    setActivities((current) =>
      current.some((item) => item.id === id) ? current.filter((item) => item.id !== id) : current,
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let frame = 0;
    const latest = new Map<string, string>();
    const flush = () => {
      frame = 0;
      const batch = new Map(latest);
      latest.clear();
      setActivities((current) =>
        current.map((item) => {
          const line = batch.get(item.id);
          if (line === undefined) return item;
          const progress = progressFromGitLine(line);
          return { ...item, detail: line, progress: progress ?? item.progress };
        }),
      );
    };
    void listen<{ id: string; line: string }>("git-progress", (event) => {
      latest.set(event.payload.id, event.payload.line);
      if (!frame) frame = requestAnimationFrame(flush);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      unlisten?.();
    };
  }, []);

  const hydrateRepo = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "repo") return;
      if (sessionsRef.current[tabId]?.snapshot) return;

      const pendingKey = tab.path.toLowerCase();
      if (openingPathsRef.current.has(pendingKey)) return;
      openingPathsRef.current.add(pendingKey);
      try {
        const snapshot = await runActivity("Opening repository", tab.path, () =>
          gitApi.openRepository(tab.path),
        );
        if (!tabsRef.current.some((item) => item.id === tabId)) return;
        const current = sessionsRef.current;
        commitSessions({
          ...current,
          [tabId]: {
            ...(current[tabId] ??
              emptySession(
                snapshot.repo.path,
                lookupHistoryRevs(historyRevsMapRef.current, snapshot.repo.path),
                lookupPathList(historyExpandedMapRef.current, snapshot.repo.path),
              )),
            snapshot,
          },
        });
        syncTabMeta(tabId, snapshot);
        setRecents(await gitApi.listRecents());
      } catch (error) {
        reportError(error);
      } finally {
        openingPathsRef.current.delete(pendingKey);
      }
    },
    [commitSessions, runActivity, syncTabMeta],
  );

  const setActiveTab = useCallback(
    (id: string) => {
      commitActiveTabId(id);
      void hydrateRepo(id);
    },
    [commitActiveTabId, hydrateRepo],
  );

  useEffect(() => {
    if (loading) return;
    void hydrateRepo(activeTabId);
  }, [activeTabId, hydrateRepo, loading]);

  const openPath = useCallback(async (path: string) => {
    const existing = findRepoTab(tabsRef.current, path);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    const pendingKey = path.toLowerCase();
    if (openingPathsRef.current.has(pendingKey)) return;
    openingPathsRef.current.add(pendingKey);
    try {
      const snapshot = await runActivity("Opening repository", path, () =>
        gitApi.openRepository(path),
      );
      const tab = findRepoTab(tabsRef.current, snapshot.repo.path) ?? tabFromSnapshot(snapshot);
      const current = sessionsRef.current;
      commitSessions({
        ...current,
        [tab.id]: {
          ...(current[tab.id] ??
            emptySession(
              snapshot.repo.path,
              lookupHistoryRevs(historyRevsMapRef.current, snapshot.repo.path),
              lookupPathList(historyExpandedMapRef.current, snapshot.repo.path),
            )),
          snapshot,
        },
      });
      if (!tabsRef.current.some((item) => item.id === tab.id)) {
        commitTabs([...tabsRef.current, tab]);
      }
      commitActiveTabId(tab.id);
      setRecents(await gitApi.listRecents());
    } catch (error) {
      reportError(error);
    } finally {
      openingPathsRef.current.delete(pendingKey);
    }
  }, [commitActiveTabId, commitSessions, commitTabs, runActivity, setActiveTab]);

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

  const cloneRepository = useCallback(
    async (url: string, destination: string) => {
      try {
        const path = await runActivity(
          "Cloning repository",
          url.trim(),
          (activityId) => gitApi.cloneRepository(url, destination, activityId),
          true,
        );
        await openPath(path);
        return true;
      } catch (error) {
        if (isCancelled(error)) toast.info("Cancelled: Cloning repository");
        else reportError(error);
        return false;
      }
    },
    [openPath, runActivity],
  );

  const forgetRecent = useCallback(async (path: string) => {
    try {
      setRecents(await gitApi.forgetRecent(path));
    } catch (error) {
      reportError(error);
    }
  }, []);

  const reorderTabs = useCallback(
    (fromId: string, toId: string, place: "before" | "after") => {
      const next = reorderAppTabs(tabsRef.current, fromId, toId, place);
      if (next !== tabsRef.current) commitTabs(next);
    },
    [commitTabs],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (id === WELCOME_TAB_ID) return;
      const current = tabsRef.current;
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabIdRef.current === id) {
        commitActiveTabId(next[Math.max(0, index - 1)]?.id ?? WELCOME_TAB_ID);
      }
      commitTabs(next.length > 0 ? next : [{ id: WELCOME_TAB_ID, kind: "welcome" }]);
      const { [id]: _dropped, ...rest } = sessionsRef.current;
      commitSessions(rest);
    },
    [commitActiveTabId, commitSessions, commitTabs],
  );

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
      reportError(error);
    }
  }, [activeRepoPath]);

  const openTerminal = useCallback(async () => {
    const path = activeRepoPath();
    if (!path) return;
    try {
      await gitApi.openInTerminal(path);
    } catch (error) {
      reportError(error);
    }
  }, [activeRepoPath]);

  const ensureBranches = useCallback(async (force = false) => {
    const repoPath = activeRepoPath();
    const tabId = activeTabIdRef.current;
    const current = sessionsRef.current[tabId];
    if (!repoPath || !current?.snapshot) return;
    if (!force && current.snapshot.branches.remote.length > 0) return;
    try {
      const branches = await gitApi.getBranches(repoPath);
      const snapshot = sessionsRef.current[tabId]?.snapshot;
      if (!snapshot) return;
      patchSession(tabId, { snapshot: { ...snapshot, branches } });
    } catch (error) {
      reportError(error);
    }
  }, [activeRepoPath, patchSession]);

  const historyEpochRef = useRef<Record<string, number>>({});
  const historyInflightRef = useRef<Record<string, number>>({});

  const bumpHistoryEpoch = useCallback((tabId: string) => {
    const next = (historyEpochRef.current[tabId] ?? 0) + 1;
    historyEpochRef.current[tabId] = next;
    return next;
  }, []);

  const loadHistoryPage = useCallback(
    async (tabId: string, reset: boolean) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      const repoPath = tab?.kind === "repo" ? tab.path : null;
      const current = sessionsRef.current[tabId];
      if (!repoPath || !current) return;
      if (!reset && (!current.commitsLoaded || current.commitsLoading || !current.commitsHasMore)) {
        return;
      }

      const epoch = reset ? bumpHistoryEpoch(tabId) : (historyEpochRef.current[tabId] ?? 0);
      const skip = reset ? 0 : current.commits.length;
      const revs = expandHistoryRevs(current.historyRevs, current.snapshot?.branches.local);
      historyInflightRef.current[tabId] = (historyInflightRef.current[tabId] ?? 0) + 1;
      patchSession(tabId, { commitsLoading: true });
      let stale = false;
      try {
        const page = await runActivity(
          reset ? "Loading history" : "Loading earlier history",
          current.snapshot?.repo.name,
          () => gitApi.getCommits(repoPath, COMMIT_PAGE, skip, undefined, revs),
        );
        stale = historyEpochRef.current[tabId] !== epoch;
        if (stale) return;
        const latest = sessionsRef.current[tabId];
        patchSession(tabId, {
          commits: reset ? page : [...(latest?.commits ?? []), ...page],
          commitsLoaded: true,
          commitsHasMore: page.length === COMMIT_PAGE,
          commitsLoading: false,
        });
      } catch (error) {
        stale = historyEpochRef.current[tabId] !== epoch;
        if (stale) return;
        patchSession(tabId, { commitsLoading: false });
        reportError(error);
      } finally {
        historyInflightRef.current[tabId] = Math.max(0, (historyInflightRef.current[tabId] ?? 1) - 1);
        if (stale && historyInflightRef.current[tabId] === 0) {
          patchSession(tabId, { commitsLoading: false });
        }
      }
    },
    [bumpHistoryEpoch, patchSession, runActivity],
  );

  const ensureHistory = useCallback(async () => {
    const tabId = activeTabIdRef.current;
    const current = sessionsRef.current[tabId];
    if (!current || current.commitsLoaded || current.commitsLoading) return;
    await loadHistoryPage(tabId, true);
  }, [loadHistoryPage]);

  // For callers that already marked history stale in their own patch. Bumping
  // the epoch keeps a page that was in flight from marking it loaded again.
  const refetchStaleHistory = useCallback(
    (tabId: string) => {
      if (sessionsRef.current[tabId]?.view === "history") void loadHistoryPage(tabId, true);
      else bumpHistoryEpoch(tabId);
    },
    [bumpHistoryEpoch, loadHistoryPage],
  );

  const invalidateHistory = useCallback(
    (tabId: string, reload: boolean) => {
      if (reload) {
        void loadHistoryPage(tabId, true);
        return;
      }
      bumpHistoryEpoch(tabId);
      patchSession(tabId, {
        commitsLoaded: false,
        commitsHasMore: true,
        commitsLoading: false,
      });
    },
    [bumpHistoryEpoch, loadHistoryPage, patchSession],
  );

  const loadMoreCommits = useCallback(async () => {
    await loadHistoryPage(activeTabIdRef.current, false);
  }, [loadHistoryPage]);

  const setHistoryRevs = useCallback(
    (revs: string[]) => {
      const tabId = activeTabIdRef.current;
      const current = sessionsRef.current[tabId];
      const next = [...new Set(revs.map((rev) => rev.trim()).filter(Boolean))];
      if (!current || sameRevs(current.historyRevs, next)) return;
      bumpHistoryEpoch(tabId);
      historyRevsMapRef.current = { ...historyRevsMapRef.current, [current.path]: next };
      patchSession(tabId, {
        historyRevs: next,
        commitsLoaded: false,
        commitsHasMore: true,
      });
      persistSession(tabsRef.current, activeTabIdRef.current);
      refetchStaleHistory(tabId);
    },
    [bumpHistoryEpoch, patchSession, persistSession, refetchStaleHistory],
  );

  const setHistoryExpanded = useCallback(
    (ids: string[]) => {
      const tabId = activeTabIdRef.current;
      const current = sessionsRef.current[tabId];
      const next = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (!current || (current.historyExpanded !== null && sameRevs(current.historyExpanded, next))) {
        return;
      }
      historyExpandedMapRef.current = { ...historyExpandedMapRef.current, [current.path]: next };
      patchSession(tabId, { historyExpanded: next });
      persistSession(tabsRef.current, activeTabIdRef.current);
    },
    [patchSession, persistSession],
  );

  const stashPatchFor = useCallback((tabId: string, stashes: StashInfo[]): Partial<RepoSession> => {
    const selection = sessionsRef.current[tabId]?.stashSelection;
    if (!selection) return {};
    const match = stashes.find((stash) => stash.id === selection.id);
    if (!match) {
      stashLoadGen.current += 1;
      return { stashSelection: null, stashDetails: null, stashDiff: null };
    }
    if (match.index !== selection.index) {
      return { stashSelection: { ...selection, index: match.index } };
    }
    return {};
  }, []);

  const refreshFlight = useRef({
    running: false,
    queued: new Map<string, RefreshHint>(),
  });

  const refreshRepo = useCallback(
    (path: string, hint?: RefreshHint) => {
      const flight = refreshFlight.current;
      const incoming = hint ?? { paths: [], overflow: true };
      const existing = flight.queued.get(path);
      if (existing) mergeRefreshHint(existing, incoming);
      else {
        flight.queued.set(path, {
          overflow: incoming.overflow,
          paths: incoming.overflow ? [] : [...incoming.paths],
        });
      }
      if (flight.running) return;
      flight.running = true;
      void (async () => {
        try {
          for (;;) {
            const next = flight.queued.keys().next().value;
            if (!next) break;
            const job = flight.queued.get(next);
            flight.queued.delete(next);
            if (!job) continue;
            const tab = findRepoTab(tabsRef.current, next);
            if (!tab) continue;
            const current = sessionsRef.current[tab.id];
            const changeGeneration = changeLoadGen.current;
            try {
              const snapshot = keepRemoteBranches(current?.snapshot, await gitApi.refreshWorkspace(next));
              const graphChanged = historyGraphChanged(current?.snapshot, snapshot);
              let changeDiff = current?.changeDiff ?? null;
              const selection = current?.changeSelection;
              if (selection && shouldReloadWorkdirDiff(job, next, selection.path)) {
                try {
                  changeDiff = await gitApi.getWorkdirDiff(
                    next,
                    selection.path,
                    selection.staged,
                    prefsRef.current.diffIgnoreWhitespace,
                  );
                } catch {
                  changeDiff = null;
                }
              }
              const snapshotSame = sameSnapshot(current?.snapshot, snapshot);
              const selectionMoved = changeLoadGen.current !== changeGeneration;
              const diffSame =
                selectionMoved ||
                sameDiff(changeDiff, sessionsRef.current[tab.id]?.changeDiff ?? null);
              if (!diffSame) changeLoadGen.current += 1;
              if (!snapshotSame || !diffSame) {
                const stashPatch = snapshotSame ? {} : stashPatchFor(tab.id, snapshot.stashes);
                const patch = {
                  ...(snapshotSame ? {} : { snapshot, ...stashPatch }),
                  ...(diffSame ? {} : { changeDiff }),
                };
                startTransition(() => {
                  patchSession(tab.id, patch);
                });
              }
              if (graphChanged) {
                invalidateHistory(tab.id, current?.view === "history");
              }
            } catch {
              // Watch refreshes stay quiet when a repo is mid-write.
            }
          }
        } finally {
          flight.running = false;
          if (flight.queued.size > 0) {
            const next = flight.queued.keys().next().value;
            const job = next ? flight.queued.get(next) : undefined;
            if (next && job) {
              flight.queued.delete(next);
              refreshRepo(next, job);
            }
          }
        }
      })();
    },
    [invalidateHistory, patchSession, stashPatchFor],
  );

  const watchedKey = useMemo(
    () =>
      Object.values(sessions)
        .filter((item) => item.snapshot)
        .map((item) => item.path)
        .sort((left, right) => left.localeCompare(right))
        .join("\n"),
    [sessions],
  );

  useEffect(() => {
    void gitApi.syncWatches(watchedKey ? watchedKey.split("\n") : []).catch(() => undefined);
  }, [watchedKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ path: string; paths?: string[]; overflow?: boolean } | string>("repo-changed", (event) => {
      const payload = event.payload;
      if (typeof payload === "string") {
        refreshRepo(payload, { paths: [], overflow: true });
        return;
      }
      refreshRepo(payload.path, {
        paths: payload.paths ?? [],
        overflow: payload.overflow ?? true,
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshRepo]);

  const setView = useCallback(
    (view: View) => {
      const tabId = activeTabIdRef.current;
      const current = sessionsRef.current[tabId];
      patchSession(tabId, { view });
      if (view === "history" && current && !current.commitsLoaded && !current.commitsLoading) {
        void loadHistoryPage(tabId, true);
      }
    },
    [loadHistoryPage, patchSession],
  );

  const selectChange = useCallback(
    async (path: string, staged: boolean) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const generation = ++changeLoadGen.current;
      const previous = sessionsRef.current[tabId]?.changeSelection;
      const samePath = previous?.path === path && previous.staged === staged;
      patchSession(tabId, {
        view: "changes",
        changeSelection: { type: "change", path, staged },
        ...(samePath ? {} : { changeDiff: null }),
      });
      try {
        const changeDiff = await gitApi.getWorkdirDiff(
          repoPath,
          path,
          staged,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (changeLoadGen.current !== generation) return;
        patchSession(tabId, { changeDiff });
      } catch (error) {
        if (changeLoadGen.current !== generation) return;
        patchSession(tabId, { changeDiff: null });
        reportError(error);
      }
    },
    [activeRepoPath, patchSession],
  );

  const selectCommit = useCallback(
    async (id: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      if (sessionsRef.current[tabId]?.comparison) {
        patchSession(tabId, { view: "history", historySelection: { type: "commit", id } });
        return;
      }
      const current = sessionsRef.current[tabId];
      const shown = current?.commitDetails;
      const selectedPath = current?.historySelection?.path;
      const alreadyShown =
        current?.view === "history" &&
        current.historySelection?.id === id &&
        shown?.commit.id === id &&
        (shown.files.length === 0 ||
          (selectedPath != null &&
            current.historyDiff?.path === selectedPath &&
            shown.files.some((file) => file.path === selectedPath)));
      if (alreadyShown) return;

      const generation = ++historyLoadGen.current;
      const holdPath = current?.historySelection?.path;
      patchSession(tabId, {
        view: "history",
        historySelection: holdPath ? { type: "commit", id, path: holdPath } : { type: "commit", id },
      });
      await afterPaint();
      if (historyLoadGen.current !== generation) return;

      const repoName = sessionsRef.current[tabId]?.snapshot?.repo.name;
      const activityId = beginActivity("Loading commit files", repoName);
      try {
        startTransition(() => {
          patchSession(
            tabId,
            {
              historySelection: { type: "commit", id },
              commitDetails: null,
              historyDiff: null,
            },
            generation,
          );
        });
        const details = await gitApi.getCommitDetails(repoPath, id);
        if (historyLoadGen.current !== generation) return;
        const first = details.files[0];
        startTransition(() => {
          patchSession(
            tabId,
            {
              commitDetails: details,
              historySelection: first ? { type: "commit", id, path: first.path } : { type: "commit", id },
              historyDiff: first?.binary ? emptyBinaryDiff(first.path, first.oldPath) : null,
            },
            generation,
          );
        });
        if (!first || first.binary) {
          await afterPaint();
          return;
        }
        patchActivity(activityId, { label: "Loading file diff", detail: first.path });
        const historyDiff = await gitApi.getCommitDiff(
          repoPath,
          id,
          first.path,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (historyLoadGen.current !== generation) return;
        startTransition(() => {
          patchSession(tabId, { historyDiff }, generation);
        });
        await afterPaint();
      } catch (error) {
        if (historyLoadGen.current !== generation) return;
        patchSession(tabId, { commitDetails: null, historyDiff: null }, generation);
        reportError(error);
      } finally {
        endActivity(activityId);
      }
    },
    [activeRepoPath, beginActivity, endActivity, patchActivity, patchSession],
  );

  const selectCommitFile = useCallback(
    async (id: string, path: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const current = sessionsRef.current[tabId];
      if (
        current?.view === "history" &&
        current.historySelection?.id === id &&
        current.historySelection.path === path &&
        current.historyDiff?.path === path
      ) {
        return;
      }

      const generation = ++historyLoadGen.current;
      patchSession(tabId, { view: "history", historySelection: { type: "commit", id, path } });
      await afterPaint();
      if (historyLoadGen.current !== generation) return;

      const cached =
        sessionsRef.current[tabId]?.commitDetails?.commit.id === id
          ? sessionsRef.current[tabId]?.commitDetails
          : null;
      const repoName = sessionsRef.current[tabId]?.snapshot?.repo.name;
      const activityId = beginActivity(
        cached ? "Loading file diff" : "Loading commit files",
        cached ? path : repoName,
      );
      try {
        const details =
          cached ??
          (await gitApi.getCommitDetails(repoPath, id));
        if (historyLoadGen.current !== generation) return;
        if (!cached) {
          startTransition(() => {
            patchSession(tabId, { commitDetails: details }, generation);
          });
        }
        const file = details.files.find((item) => item.path === path);
        if (file?.binary) {
          startTransition(() => {
            patchSession(
              tabId,
              { commitDetails: details, historyDiff: emptyBinaryDiff(path, file.oldPath) },
              generation,
            );
          });
          await afterPaint();
          return;
        }
        if (!cached) {
          patchActivity(activityId, { label: "Loading file diff", detail: path });
        }
        startTransition(() => {
          patchSession(tabId, { historyDiff: null }, generation);
        });
        const historyDiff = await gitApi.getCommitDiff(
          repoPath,
          id,
          path,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (historyLoadGen.current !== generation) return;
        startTransition(() => {
          patchSession(tabId, { commitDetails: details, historyDiff }, generation);
        });
        await afterPaint();
      } catch (error) {
        if (historyLoadGen.current !== generation) return;
        patchSession(tabId, { historyDiff: null }, generation);
        reportError(error);
      } finally {
        endActivity(activityId);
      }
    },
    [activeRepoPath, beginActivity, endActivity, patchActivity, patchSession],
  );

  const loadComparison = useCallback(
    async (base: CompareRevision, head: CompareRevision) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const generation = ++compareLoadGen.current;
      patchSession(tabId, {
        view: "history",
        comparison: { base, head, files: null, path: null },
        historyDiff: null,
      });
      try {
        const files = await gitApi.compareRevisions(repoPath, base.rev, head.rev);
        if (compareLoadGen.current !== generation) return;
        const first = files[0];
        patchSession(tabId, {
          comparison: { base, head, files, path: first?.path ?? null },
          historyDiff: first?.binary ? emptyBinaryDiff(first.path, first.oldPath) : null,
        });
        if (!first || first.binary) return;
        const historyDiff = await gitApi.compareFileDiff(
          repoPath,
          base.rev,
          head.rev,
          first.path,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (compareLoadGen.current !== generation) return;
        patchSession(tabId, { historyDiff });
      } catch (error) {
        if (compareLoadGen.current !== generation) return;
        patchSession(tabId, { comparison: null, historyDiff: null });
        reportError(error);
      }
    },
    [activeRepoPath, patchSession],
  );

  const openComparison = useCallback(
    (base: CompareRevision, head: CompareRevision) => {
      void loadComparison(base, head);
    },
    [loadComparison],
  );

  const swapComparison = useCallback(() => {
    const current = sessionsRef.current[activeTabIdRef.current]?.comparison;
    if (!current) return;
    void loadComparison(current.head, current.base);
  }, [loadComparison]);

  const closeFile = useCallback(
    (source: "changes" | "history" | "stash") => {
      const tabId = activeTabIdRef.current;
      const current = sessionsRef.current[tabId];
      if (source === "changes") {
        changeLoadGen.current += 1;
        patchSession(tabId, { changeSelection: null, changeDiff: null });
        return;
      }
      if (source === "stash") {
        const selected = current?.stashSelection;
        if (!selected?.path) return;
        stashLoadGen.current += 1;
        patchSession(tabId, {
          stashSelection: { type: "stash", id: selected.id, index: selected.index },
          stashDiff: null,
        });
        return;
      }
      historyLoadGen.current += 1;
      compareLoadGen.current += 1;
      if (current?.comparison) {
        patchSession(tabId, {
          comparison: { ...current.comparison, path: null },
          historyDiff: null,
        });
        return;
      }
      const selected = current?.historySelection;
      if (!selected?.path) return;
      patchSession(tabId, {
        historySelection: { type: "commit", id: selected.id },
        historyDiff: null,
      });
    },
    [patchSession],
  );

  const closeStash = useCallback(() => {
    const tabId = activeTabIdRef.current;
    stashLoadGen.current += 1;
    patchSession(tabId, { stashSelection: null, stashDetails: null, stashDiff: null });
  }, [patchSession]);

  const closeCommit = useCallback(() => {
    const tabId = activeTabIdRef.current;
    historyLoadGen.current += 1;
    compareLoadGen.current += 1;
    patchSession(tabId, {
      historySelection: null,
      historyDiff: null,
      commitDetails: null,
      comparison: null,
    });
  }, [patchSession]);

  const closeComparison = useCallback(() => {
    const tabId = activeTabIdRef.current;
    compareLoadGen.current += 1;
    const selected = sessionsRef.current[tabId]?.historySelection;
    patchSession(tabId, {
      comparison: null,
      historyDiff: null,
      historySelection: selected ? { type: "commit", id: selected.id } : null,
    });
    if (selected) void selectCommit(selected.id);
  }, [patchSession, selectCommit]);

  const selectCompareFile = useCallback(
    async (path: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      const current = sessionsRef.current[tabId]?.comparison;
      if (!repoPath || !current?.files) return;
      const file = current.files.find((item) => item.path === path);
      if (!file) return;
      const generation = ++compareLoadGen.current;
      patchSession(tabId, {
        comparison: { ...current, path },
        historyDiff: file.binary ? emptyBinaryDiff(path, file.oldPath) : null,
      });
      if (file.binary) return;
      try {
        const historyDiff = await gitApi.compareFileDiff(
          repoPath,
          current.base.rev,
          current.head.rev,
          path,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (compareLoadGen.current !== generation) return;
        patchSession(tabId, { historyDiff });
      } catch (error) {
        if (compareLoadGen.current !== generation) return;
        patchSession(tabId, { historyDiff: null });
        reportError(error);
      }
    },
    [activeRepoPath, patchSession],
  );

  const selectStash = useCallback(
    async (stash: StashInfo) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const current = sessionsRef.current[tabId];
      if (
        current?.stashSelection?.id === stash.id &&
        current.stashDetails?.id === stash.id &&
        (current.stashDetails.files.length === 0 ||
          (current.stashSelection.path != null &&
            current.stashDiff?.path === current.stashSelection.path))
      ) {
        return;
      }

      const generation = ++stashLoadGen.current;
      patchSession(
        tabId,
        {
          stashSelection: { type: "stash", id: stash.id, index: stash.index },
          stashDetails: null,
          stashDiff: null,
        },
        generation,
        "stash",
      );
      const repoName = current?.snapshot?.repo.name;
      const activityId = beginActivity("Loading stash", repoName);
      try {
        const details = await gitApi.getStashDetails(repoPath, stash.id);
        if (stashLoadGen.current !== generation) return;
        const first = details.files[0];
        patchSession(
          tabId,
          {
            stashDetails: details,
            stashSelection: first
              ? { type: "stash", id: stash.id, index: stash.index, path: first.path }
              : { type: "stash", id: stash.id, index: stash.index },
            stashDiff: first?.binary ? emptyBinaryDiff(first.path, first.oldPath) : null,
          },
          generation,
          "stash",
        );
        if (!first || first.binary) return;
        patchActivity(activityId, { label: "Loading file diff", detail: first.path });
        const stashDiff = await gitApi.getStashDiff(
          repoPath,
          stash.id,
          first.path,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (stashLoadGen.current !== generation) return;
        patchSession(tabId, { stashDiff }, generation, "stash");
      } catch (error) {
        if (stashLoadGen.current !== generation) return;
        patchSession(tabId, { stashDetails: null, stashDiff: null }, generation, "stash");
        reportError(error);
      } finally {
        endActivity(activityId);
      }
    },
    [activeRepoPath, beginActivity, endActivity, patchActivity, patchSession],
  );

  const selectStashFile = useCallback(
    async (id: string, path: string) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return;
      const current = sessionsRef.current[tabId];
      if (
        current?.stashSelection?.id === id &&
        current.stashSelection.path === path &&
        current.stashDiff?.path === path
      ) {
        return;
      }

      const generation = ++stashLoadGen.current;
      const index =
        current?.stashSelection?.id === id
          ? current.stashSelection.index
          : (current?.snapshot?.stashes.find((stash) => stash.id === id)?.index ?? 0);
      const cached = current?.stashDetails?.id === id ? current.stashDetails : null;
      const file = cached?.files.find((item) => item.path === path);
      patchSession(
        tabId,
        {
          stashSelection: { type: "stash", id, index, path },
          stashDiff: file?.binary ? emptyBinaryDiff(path, file.oldPath) : null,
        },
        generation,
        "stash",
      );
      if (file?.binary) return;

      const activityId = beginActivity("Loading file diff", path);
      try {
        const stashDiff = await gitApi.getStashDiff(
          repoPath,
          id,
          path,
          prefsRef.current.diffIgnoreWhitespace,
        );
        if (stashLoadGen.current !== generation) return;
        patchSession(tabId, { stashDiff }, generation, "stash");
      } catch (error) {
        if (stashLoadGen.current !== generation) return;
        patchSession(tabId, { stashDiff: null }, generation, "stash");
        reportError(error);
      } finally {
        endActivity(activityId);
      }
    },
    [activeRepoPath, beginActivity, endActivity, patchSession],
  );

  const runMutation = useCallback(
    async (
      label: string,
      action: (repoPath: string, activityId: string) => Promise<WorkspaceSnapshot>,
      success?: string,
      options?: { cancellable?: boolean },
    ) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return false;
      const current = sessionsRef.current[tabId];
      const changeSelection = current?.changeSelection ?? null;
      const changeGeneration = changeLoadGen.current;
      try {
        const next = await runActivity(label, current?.snapshot?.repo.name, async (activityId) => {
          const snapshot = keepRemoteBranches(current?.snapshot, await action(repoPath, activityId));
          let changeDiff = current?.changeDiff ?? null;
          let nextSelection = changeSelection;
          if (changeSelection) {
            try {
              changeDiff = await gitApi.getWorkdirDiff(
                repoPath,
                changeSelection.path,
                changeSelection.staged,
                prefsRef.current.diffIgnoreWhitespace,
              );
            } catch {
              changeDiff = null;
              nextSelection = null;
            }
          }
          const headChanged = current?.snapshot?.repo.headId !== snapshot.repo.headId;
          return { snapshot, changeDiff, changeSelection: nextSelection, headChanged };
        }, options?.cancellable);
        const selectionMoved = changeLoadGen.current !== changeGeneration;
        if (!selectionMoved) changeLoadGen.current += 1;
        patchSession(tabId, {
          snapshot: next.snapshot,
          ...(selectionMoved
            ? {}
            : { changeDiff: next.changeDiff, changeSelection: next.changeSelection }),
          ...stashPatchFor(tabId, next.snapshot.stashes),
          ...(next.headChanged
            ? {
                commitsLoaded: false,
                commitsHasMore: true,
              }
            : {}),
        });
        if (next.headChanged) refetchStaleHistory(tabId);
        if (success) toast.success(success);
        return true;
      } catch (error) {
        if (isCancelled(error)) toast.info(`Cancelled: ${label}`);
        else reportError(error);
        return false;
      }
    },
    [activeRepoPath, patchSession, refetchStaleHistory, runActivity, stashPatchFor],
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

  const applyLines = useCallback(
    async (path: string, staged: boolean, action: LineAction, lines: LineRef[]) => {
      const count = lines.length === 1 ? "1 line" : `${lines.length} lines`;
      const label =
        action === "stage" ? `Staging ${count}` : action === "unstage" ? `Unstaging ${count}` : `Discarding ${count}`;
      return runMutation(
        label,
        (repoPath) => gitApi.applyLines(repoPath, path, staged, action, lines),
        action === "discard" ? `Discarded ${count}` : undefined,
      );
    },
    [runMutation],
  );

  const commitDraftNonce = useRef(0);
  const undoLastCommit = useCallback(async () => {
    let message = "";
    const ok = await runMutation(
      "Undoing the last commit",
      (repoPath) =>
        gitApi.undoLastCommit(repoPath).then((undone) => {
          message = undone.message;
          return undone.snapshot;
        }),
      "Undid the last commit; its changes are staged",
    );
    if (ok) {
      commitDraftNonce.current += 1;
      patchSession(activeTabIdRef.current, {
        view: "changes",
        commitDraft: { text: message, nonce: commitDraftNonce.current },
      });
    }
    return ok;
  }, [patchSession, runMutation]);

  const commit = useCallback(
    async (message: string, amend = false) => {
      const ok = await runMutation(amend ? "Amending commit" : "Creating commit", (repoPath) =>
        gitApi.commit(repoPath, message, amend),
      );
      if (ok) {
        patchSession(activeTabIdRef.current, { changeSelection: null, changeDiff: null });
        if (amend) toast.success("Amended commit");
        else toast.success("Created commit", { action: { label: "Undo", onClick: () => void undoLastCommit() } });
      }
      return ok;
    },
    [patchSession, runMutation, undoLastCommit],
  );

  const updateSubmodules = useCallback(
    async (paths: string[]) => {
      const label = paths.length === 1 ? `Updating submodule ${paths[0]}` : "Updating submodules";
      return runMutation(
        label,
        (repoPath, activityId) => gitApi.updateSubmodules(repoPath, paths, activityId),
        paths.length === 1 ? `Updated ${paths[0]}` : "Updated submodules",
        { cancellable: true },
      );
    },
    [runMutation],
  );

  const checkoutDetached = useCallback(
    async (oid: string) => {
      const ok = await runMutation(
        `Checking out ${oid.slice(0, 7)}`,
        (repoPath) => gitApi.checkoutDetached(repoPath, oid),
        `Checked out ${oid.slice(0, 7)} without a branch`,
      );
      if (ok) {
        patchSession(activeTabIdRef.current, { changeSelection: null, changeDiff: null });
      }
      return ok;
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
      const tabId = activeTabIdRef.current;
      patchSession(tabId, {
        changeSelection: null,
        changeDiff: null,
        commitsLoaded: false,
        commitsHasMore: true,
      });
      refetchStaleHistory(tabId);
    },
    [patchSession, refetchStaleHistory, runMutation],
  );

  const refreshAfterFetch = useCallback(
    async (ok: boolean) => {
      await ensureBranches(true);
      if (ok) {
        invalidateHistory(
          activeTabIdRef.current,
          sessionsRef.current[activeTabIdRef.current]?.view === "history",
        );
      }
    },
    [ensureBranches, invalidateHistory],
  );

  // When each repository last fetched, keyed by normalized path, so background
  // fetches wait a full interval after any fetch.
  const lastFetchRef = useRef<Record<string, number>>({});
  const fetchingRef = useRef(new Set<string>());
  const markFetched = useCallback(() => {
    const path = activeRepoPath();
    if (path) lastFetchRef.current[normalizeRepoPath(path)] = Date.now();
  }, [activeRepoPath]);

  const fetchRemote = useCallback(
    async (remote?: string) => {
      const named = remote?.trim();
      const target =
        named || defaultFetchRemote(sessionsRef.current[activeTabIdRef.current]?.snapshot);
      const ok = await runMutation(
        target ? `Fetching ${target}` : "Fetching",
        (repoPath, activityId) =>
          gitApi.fetchRemote(repoPath, activityId, named || undefined, false, {
            prune: prefsRef.current.fetchPrune,
          }),
        target ? `Fetched ${target}` : "Fetched",
        { cancellable: true },
      );
      if (ok) markFetched();
      await refreshAfterFetch(ok);
    },
    [markFetched, refreshAfterFetch, runMutation],
  );

  const fetchAllRemotes = useCallback(async () => {
    const ok = await runMutation(
      "Fetching all remotes",
      (repoPath, activityId) =>
        gitApi.fetchRemote(repoPath, activityId, undefined, true, { prune: prefsRef.current.fetchPrune }),
      "Fetched all remotes",
      { cancellable: true },
    );
    if (ok) markFetched();
    await refreshAfterFetch(ok);
  }, [markFetched, refreshAfterFetch, runMutation]);

  /** Fetches every remote without prompts or toasts; failures stay quiet. */
  const backgroundFetch = useCallback(
    async (tabId: string, repoPath: string) => {
      const key = normalizeRepoPath(repoPath);
      if (fetchingRef.current.has(key)) return;
      fetchingRef.current.add(key);
      lastFetchRef.current[key] = Date.now();
      try {
        const fetched = await runActivity(
          "Fetching in the background",
          sessionsRef.current[tabId]?.snapshot?.repo.name,
          (activityId) =>
            gitApi.fetchRemote(repoPath, activityId, undefined, true, {
              prune: prefsRef.current.fetchPrune,
              background: true,
            }),
          true,
        );
        const current = sessionsRef.current[tabId];
        if (!current) return;
        const snapshot = keepRemoteBranches(current.snapshot, fetched);
        const changed = !sameSnapshot(current.snapshot, snapshot);
        if (changed) patchSession(tabId, { snapshot });
        if (activeTabIdRef.current !== tabId) return;
        await ensureBranches(true);
        if (changed || historyGraphChanged(current.snapshot, snapshot)) {
          invalidateHistory(tabId, sessionsRef.current[tabId]?.view === "history");
        }
      } catch {
        // Offline, signed out, or cancelled: the next manual fetch will say why.
      } finally {
        fetchingRef.current.delete(key);
      }
    },
    [ensureBranches, invalidateHistory, patchSession, runActivity],
  );

  useEffect(() => {
    const minutes = prefs.autoFetchMinutes;
    if (!minutes) return;
    const interval = minutes * 60_000;
    const timer = window.setInterval(() => {
      const tab = tabsRef.current.find((item) => item.id === activeTabIdRef.current);
      if (tab?.kind !== "repo") return;
      const snapshot = sessionsRef.current[tab.id]?.snapshot;
      if (!snapshot || snapshot.remotes.length === 0) return;
      const key = normalizeRepoPath(tab.path);
      const last = lastFetchRef.current[key];
      const now = Date.now();
      // A repository seen for the first time fetches about half a minute later.
      if (last === undefined) {
        lastFetchRef.current[key] = now - interval + 30_000;
        return;
      }
      if (now - last >= interval) void backgroundFetch(tab.id, tab.path);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [backgroundFetch, prefs.autoFetchMinutes]);

  const pullRemote = useCallback(async (remote?: string, rebase = false) => {
    const snapshot = sessionsRef.current[activeTabIdRef.current]?.snapshot;
    const target = remote?.trim() || primaryRemote(snapshot);
    if (!target) {
      toast.error("Add a remote before pulling");
      return;
    }
    const ok = await runMutation(
      rebase ? `Rebasing onto ${target}` : `Pulling from ${target}`,
      (repoPath, activityId) => gitApi.pullRemote(repoPath, activityId, target, rebase),
      rebase ? `Rebased onto ${target}` : `Pulled from ${target}`,
      { cancellable: true },
    );
    if (ok) markFetched();
    await ensureBranches(true);
    if (ok) invalidateHistory(activeTabIdRef.current, sessionsRef.current[activeTabIdRef.current]?.view === "history");
    else await refreshAfterReplayRef.current();
  }, [ensureBranches, invalidateHistory, markFetched, runMutation]);

  const pushRemote = useCallback(
    async (options?: { remote?: string; force?: boolean; setUpstream?: boolean }) => {
      const snapshot = sessionsRef.current[activeTabIdRef.current]?.snapshot;
      if (!snapshot) return false;
      const remote = options?.remote?.trim() || primaryRemote(snapshot);
      if (!remote) {
        toast.error("Add a remote before pushing");
        return false;
      }
      const branch = snapshot.repo.currentBranch;
      if (!branch) {
        toast.error("Cannot push while HEAD is detached");
        return false;
      }
      if (!snapshot.repo.upstream && !options?.setUpstream) {
        setPublishPrompt({ branch, remote });
        return false;
      }
      const publishing = Boolean(options?.setUpstream);
      const force = Boolean(options?.force) && !publishing;
      const label = force ? "Force pushing" : publishing ? `Publishing to ${remote}` : `Pushing to ${remote}`;
      const success = force ? "Force pushed" : publishing ? `Published to ${remote}` : `Pushed to ${remote}`;
      return runMutation(
        label,
        (repoPath, activityId) =>
          gitApi.pushRemote(repoPath, activityId, {
            remote,
            force,
            setUpstream: publishing,
          }),
        success,
        { cancellable: true },
      );
    },
    [runMutation],
  );

  const dismissPublish = useCallback(() => setPublishPrompt(null), []);

  const publishPromptRef = useRef(publishPrompt);
  useLayoutEffect(() => {
    publishPromptRef.current = publishPrompt;
  }, [publishPrompt]);

  const confirmPublish = useCallback(async () => {
    const prompt = publishPromptRef.current;
    if (!prompt) return;
    setPublishPrompt(null);
    await pushRemote({ remote: prompt.remote, setUpstream: true });
  }, [pushRemote]);

  const createBranch = useCallback(
    async (name: string, switchTo: boolean, start?: string) => {
      const ok = await runMutation(
        switchTo ? `Creating and checking out ${name}` : `Creating ${name}`,
        (repoPath) => gitApi.createBranch(repoPath, name, switchTo, start),
        switchTo ? `Created and checked out ${name}` : `Created ${name}`,
      );
      if (!ok) return false;
      const tabId = activeTabIdRef.current;
      patchSession(tabId, {
        ...(switchTo
          ? {
              changeSelection: null,
              changeDiff: null,
            }
          : {}),
        commitsLoaded: false,
        commitsHasMore: true,
      });
      refetchStaleHistory(tabId);
      return true;
    },
    [patchSession, refetchStaleHistory, runMutation],
  );

  const createTag = useCallback(
    async (name: string, message?: string, target?: string) => {
      return runMutation(
        `Creating tag ${name}`,
        (repoPath) => gitApi.createTag(repoPath, name, message, target),
        `Created tag ${name}`,
      );
    },
    [runMutation],
  );

  const deleteTag = useCallback(
    async (name: string) => {
      const ok = await runMutation(
        `Deleting tag ${name}`,
        (repoPath) => gitApi.deleteTag(repoPath, name),
        `Deleted tag ${name}`,
      );
      if (!ok) return false;
      const tabId = activeTabIdRef.current;
      const revs = sessionsRef.current[tabId]?.historyRevs ?? [];
      if (revs.includes(name)) setHistoryRevs(revs.filter((rev) => rev !== name));
      return true;
    },
    [runMutation, setHistoryRevs],
  );

  const deleteRemoteTag = useCallback(
    async (remote: string, name: string) => {
      return runMutation(
        `Deleting tag ${name} from ${remote}`,
        (repoPath, activityId) => gitApi.deleteRemoteTag(repoPath, remote, name, activityId),
        `Deleted tag ${name} from ${remote}`,
        { cancellable: true },
      );
    },
    [runMutation],
  );

  const pushTag = useCallback(
    async (remote: string, name: string) => {
      return runMutation(
        `Pushing tag ${name}`,
        (repoPath, activityId) => gitApi.pushTag(repoPath, remote, name, activityId),
        `Pushed tag ${name}`,
        { cancellable: true },
      );
    },
    [runMutation],
  );

  const deleteBranch = useCallback(
    async (name: string, force = false) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return false;
      const current = sessionsRef.current[tabId];
      const wasRemote = current?.snapshot?.branches.remote.some((branch) => branch.name === name) ?? false;
      try {
        const snapshot = keepRemoteBranches(
          current?.snapshot,
          await runActivity(
            `Deleting ${name}`,
            current?.snapshot?.repo.name,
            (activityId) => gitApi.deleteBranch(repoPath, name, activityId, force),
            wasRemote,
          ),
        );
        patchSession(tabId, { snapshot });
        const next = sessionsRef.current[tabId];
        if (next?.historyRevs.includes(name)) {
          setHistoryRevs(next.historyRevs.filter((rev) => rev !== name));
        }
        if (wasRemote) await ensureBranches(true);
        toast.success(`Deleted ${name}`);
        return true;
      } catch (error) {
        const message = errorMessage(error);
        if (!force && /not fully merged/i.test(message)) return "unmerged";
        if (isCancelled(error)) toast.info(`Cancelled: Deleting ${name}`);
        else reportError(error);
        return false;
      }
    },
    [activeRepoPath, ensureBranches, patchSession, runActivity, setHistoryRevs],
  );

  const refreshAfterReplay = useCallback(async () => {
    const repoPath = activeRepoPath();
    const tabId = activeTabIdRef.current;
    if (!repoPath) return;
    try {
      const snapshot = keepRemoteBranches(
        sessionsRef.current[tabId]?.snapshot,
        await gitApi.refreshWorkspace(repoPath),
      );
      const dirty = snapshot.status.staged.length > 0 || snapshot.status.unstaged.length > 0;
      const headChanged = sessionsRef.current[tabId]?.snapshot?.repo.headId !== snapshot.repo.headId;
      patchSession(tabId, {
        snapshot,
        ...(dirty || snapshot.repo.operation ? { view: "changes" } : {}),
        ...(headChanged
          ? {
              commitsLoaded: false,
              commitsHasMore: true,
            }
          : {}),
      });
      if (headChanged) refetchStaleHistory(tabId);
    } catch {
      /* the original error is already shown */
    }
  }, [activeRepoPath, patchSession, refetchStaleHistory]);
  useLayoutEffect(() => {
    refreshAfterReplayRef.current = refreshAfterReplay;
  }, [refreshAfterReplay]);

  const revertCommit = useCallback(
    async (oid: string) => {
      const ok = await runMutation(
        `Reverting ${oid.slice(0, 7)}`,
        (repoPath) => gitApi.revertCommit(repoPath, oid),
        "Reverted commit",
      );
      if (!ok) await refreshAfterReplay();
      return ok;
    },
    [refreshAfterReplay, runMutation],
  );

  const rebaseOnto = useCallback(
    async (onto: string, label: string) => {
      const ok = await runMutation(
        `Rebasing onto ${label}`,
        (repoPath) => gitApi.rebaseOnto(repoPath, onto),
        `Rebased onto ${label}`,
      );
      if (!ok) await refreshAfterReplay();
      return ok;
    },
    [refreshAfterReplay, runMutation],
  );

  const rebaseInteractive = useCallback(
    async (onto: string, steps: RebaseStep[]) => {
      const ok = await runMutation(
        "Rebasing commits",
        (repoPath) => gitApi.rebaseInteractive(repoPath, onto, steps),
        "Rebased commits",
      );
      if (!ok) await refreshAfterReplay();
      return ok;
    },
    [refreshAfterReplay, runMutation],
  );

  const rebaseContinue = useCallback(async () => {
    const ok = await runMutation(
      "Continuing rebase",
      (repoPath) => gitApi.rebaseContinue(repoPath),
      "Rebase finished",
    );
    if (!ok) await refreshAfterReplay();
    return ok;
  }, [refreshAfterReplay, runMutation]);

  const rebaseSkip = useCallback(async () => {
    const ok = await runMutation(
      "Skipping commit",
      (repoPath) => gitApi.rebaseSkip(repoPath),
      "Skipped commit",
    );
    if (!ok) await refreshAfterReplay();
    return ok;
  }, [refreshAfterReplay, runMutation]);

  const rebaseAbort = useCallback(async () => {
    return runMutation(
      "Aborting rebase",
      (repoPath) => gitApi.rebaseAbort(repoPath),
      "Rebase aborted",
    );
  }, [runMutation]);

  const mergeRef = useCallback(
    async (onto: string, label: string) => {
      const ok = await runMutation(
        `Merging ${label}`,
        (repoPath) => gitApi.mergeRef(repoPath, onto),
        `Merged ${label}`,
      );
      if (!ok) await refreshAfterReplay();
      return ok;
    },
    [refreshAfterReplay, runMutation],
  );

  const operationContinue = useCallback(async (message?: string) => {
    const kind = sessionsRef.current[activeTabIdRef.current]?.snapshot?.repo.operation?.kind;
    const ok = await runMutation(
      kind ? `Continuing ${kind}` : "Continuing",
      (repoPath) => gitApi.operationContinue(repoPath, message),
      (kind && OPERATION_FINISHED[kind]) || "Operation finished",
    );
    if (!ok) await refreshAfterReplay();
    return ok;
  }, [refreshAfterReplay, runMutation]);

  const operationAbort = useCallback(async () => {
    return runMutation(
      "Aborting",
      (repoPath) => gitApi.operationAbort(repoPath),
      "Aborted",
    );
  }, [runMutation]);

  const resolveConflict = useCallback(
    async (path: string, side: "ours" | "theirs" | "both") => {
      return runMutation(
        "Resolving conflict",
        (repoPath) => gitApi.resolveConflict(repoPath, path, side),
        "Conflict resolved",
      );
    },
    [runMutation],
  );

  const saveConflict = useCallback(
    async (path: string, text: string) => {
      return runMutation(
        "Saving resolution",
        (repoPath) => gitApi.saveConflict(repoPath, path, text),
        "Conflict resolved",
      );
    },
    [runMutation],
  );

  const cherryPickCommit = useCallback(
    async (oid: string) => {
      const ok = await runMutation(
        `Cherry-picking ${oid.slice(0, 7)}`,
        (repoPath) => gitApi.cherryPickCommit(repoPath, oid),
        "Cherry-picked commit",
      );
      if (!ok) await refreshAfterReplay();
      return ok;
    },
    [refreshAfterReplay, runMutation],
  );

  const resetCommit = useCallback(
    async (oid: string, mode: ResetMode) => {
      const shortId = oid.slice(0, 7);
      return runMutation(
        `Resetting to ${shortId}`,
        (repoPath) => gitApi.resetToCommit(repoPath, oid, mode),
        `Reset ${mode} to ${shortId}`,
      );
    },
    [runMutation],
  );

  const createPatch = useCallback(
    async (commit: CommitSummary) => {
      const repoPath = activeRepoPath();
      if (!repoPath) return;
      const dest = await save({
        title: "Save patch",
        defaultPath: patchFileName(commit),
        filters: [{ name: "Patch", extensions: ["patch"] }],
      });
      if (typeof dest !== "string" || !dest) return;
      try {
        await runActivity("Creating patch", sessionsRef.current[activeTabIdRef.current]?.snapshot?.repo.name, () =>
          gitApi.writeCommitPatch(repoPath, commit.id, dest),
        );
        toast.success("Saved patch");
      } catch (error) {
        reportError(error);
      }
    },
    [activeRepoPath, runActivity],
  );

  const applyPatch = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: "Apply patch",
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    });
    if (typeof selected !== "string" || !selected) return;
    const ok = await runMutation(
      "Applying patch",
      (repoPath) => gitApi.applyPatch(repoPath, selected),
      "Applied patch",
    );
    if (!ok) await refreshAfterReplay();
  }, [refreshAfterReplay, runMutation]);

  const addRemote = useCallback(
    async (name: string, url: string) => {
      const added = await runMutation(
        `Adding ${name}`,
        (repoPath) => gitApi.addRemote(repoPath, name, url),
        `Added ${name}`,
      );
      if (!added) return false;
      await runMutation(
        `Fetching ${name}`,
        (repoPath, activityId) => gitApi.fetchRemote(repoPath, activityId, name),
        undefined,
        { cancellable: true },
      );
      const tabId = activeTabIdRef.current;
      patchSession(tabId, {
        commitsLoaded: false,
        commitsHasMore: true,
      });
      refetchStaleHistory(tabId);
      await ensureBranches(true);
      return true;
    },
    [ensureBranches, patchSession, refetchStaleHistory, runMutation],
  );

  const deleteRemote = useCallback(
    async (name: string) => {
      const tabId = activeTabIdRef.current;
      const removed = await runMutation(
        `Removing ${name}`,
        (repoPath) => gitApi.deleteRemote(repoPath, name),
        `Removed ${name}`,
      );
      if (!removed) return false;
      const prefix = `${name}/`;
      const snapshot = sessionsRef.current[tabId]?.snapshot;
      if (snapshot) {
        patchSession(tabId, {
          snapshot: {
            ...snapshot,
            remotes: snapshot.remotes.filter((remote) => remote.name !== name),
            branches: {
              ...snapshot.branches,
              remote: snapshot.branches.remote.filter((branch) => !branch.name.startsWith(prefix)),
            },
          },
        });
      }
      const next = sessionsRef.current[tabId];
      if (next?.historyRevs.some((rev) => rev === name || rev.startsWith(prefix))) {
        setHistoryRevs(next.historyRevs.filter((rev) => rev !== name && !rev.startsWith(prefix)));
      }
      const expanded = next?.historyExpanded;
      if (expanded) {
        const folder = `remote:${name}`;
        const filtered = expanded.filter((id) => id !== folder && !id.startsWith(`${folder}/`));
        if (filtered.length !== expanded.length) setHistoryExpanded(filtered);
      }
      await ensureBranches(true);
      return true;
    },
    [ensureBranches, patchSession, runMutation, setHistoryExpanded, setHistoryRevs],
  );

  const stashSave = useCallback(
    async (message: string, includeUntracked: boolean, paths?: string[]) => {
      return runMutation(
        "Saving stash",
        (repoPath) => gitApi.stashSave(repoPath, message, includeUntracked, paths),
        "Saved stash",
      );
    },
    [runMutation],
  );

  const ignorePaths = useCallback(
    async (patterns: string[]) => {
      return runMutation(
        "Updating .gitignore",
        (repoPath) => gitApi.ignorePatterns(repoPath, patterns),
        patterns.length === 1 ? `Ignored ${patterns[0]}` : `Ignored ${patterns.length} patterns`,
      );
    },
    [runMutation],
  );

  const fileFocusNonce = useRef(0);
  const showFile = useCallback(
    (path: string, mode: FileFocus["mode"]) => {
      fileFocusNonce.current += 1;
      patchSession(activeTabIdRef.current, {
        view: "files",
        fileFocus: { path, mode, nonce: fileFocusNonce.current },
      });
    },
    [patchSession],
  );

  const repoFilePath = useCallback(
    (path: string) => {
      const root = activeRepoPath();
      return root ? `${root.replace(/[\\/]+$/, "")}/${path}` : null;
    },
    [activeRepoPath],
  );

  const openRepoFile = useCallback(
    async (path: string) => {
      const full = repoFilePath(path);
      if (!full) return;
      try {
        await gitApi.openInFileManager(full);
      } catch (error) {
        reportError(error);
      }
    },
    [repoFilePath],
  );

  const revealRepoFile = useCallback(
    async (path: string) => {
      const full = repoFilePath(path);
      if (!full) return;
      try {
        await gitApi.revealInFileManager(full);
      } catch (error) {
        reportError(error);
      }
    },
    [repoFilePath],
  );

  const openInEditor = useCallback(
    async (path?: string, line?: number | null) => {
      const full = path ? repoFilePath(path) : activeRepoPath();
      if (!full) return;
      try {
        await gitApi.openInEditor(full, line);
      } catch (error) {
        reportError(error);
      }
    },
    [activeRepoPath, repoFilePath],
  );

  const openDifftool = useCallback(
    async (source: FileSource) => {
      const repoPath = activeRepoPath();
      if (!repoPath) return;
      try {
        await gitApi.openDifftool(repoPath, source);
      } catch (error) {
        reportError(error);
      }
    },
    [activeRepoPath],
  );

  const runMergetool = useCallback(
    async (path: string) => {
      return runMutation(
        `Waiting for the merge tool: ${path}`,
        (repoPath) => gitApi.runMergetool(repoPath, path),
      );
    },
    [runMutation],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ message: string }>("tool-error", (event) => {
      toast.error(event.payload.message);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const stashApply = useCallback(
    async (id: string) => {
      await runMutation("Applying stash", (repoPath) => gitApi.stashApply(repoPath, id), "Applied stash");
    },
    [runMutation],
  );

  const stashPop = useCallback(
    async (id: string) => {
      await runMutation("Popping stash", (repoPath) => gitApi.stashPop(repoPath, id), "Popped stash");
    },
    [runMutation],
  );

  const stashDrop = useCallback(
    async (id: string) => {
      await runMutation("Dropping stash", (repoPath) => gitApi.stashDrop(repoPath, id), "Dropped stash");
    },
    [runMutation],
  );

  const flushPrefs = useCallback(async (next: AppPrefs) => {
    if (persistPrefsTimer.current !== null) {
      window.clearTimeout(persistPrefsTimer.current);
      persistPrefsTimer.current = null;
    }
    const saved = normalizePrefs(await gitApi.setPrefs(next));
    prefsRef.current = saved;
    setPrefs(saved);
    try {
      const executables = await gitApi.gitExecutables();
      setGitMissing(executables.active === null);
    } catch {
      // The choice is already saved. The next launch checks again.
    }
    return saved;
  }, []);

  const updatePrefs = useCallback(
    async (next: AppPrefs) => {
      return flushPrefs(
        normalizePrefs({
          ...prefsRef.current,
          ...next,
          panelLayouts: prefsRef.current.panelLayouts,
        }),
      );
    },
    [flushPrefs],
  );

  /** Refetches the diffs on screen, e.g. after the whitespace option changes. */
  const reloadDiffs = useCallback(async () => {
    const repoPath = activeRepoPath();
    const tabId = activeTabIdRef.current;
    const current = sessionsRef.current[tabId];
    if (!repoPath || !current) return;
    const ws = prefsRef.current.diffIgnoreWhitespace;
    const jobs: Promise<void>[] = [];
    const change = current.changeSelection;
    if (change) {
      const generation = ++changeLoadGen.current;
      jobs.push(
        gitApi.getWorkdirDiff(repoPath, change.path, change.staged, ws).then((changeDiff) => {
          if (changeLoadGen.current === generation) patchSession(tabId, { changeDiff });
        }),
      );
    }
    const comparison = current.comparison;
    const history = current.historySelection;
    if (comparison?.path) {
      const generation = ++compareLoadGen.current;
      jobs.push(
        gitApi
          .compareFileDiff(repoPath, comparison.base.rev, comparison.head.rev, comparison.path, ws)
          .then((historyDiff) => {
            if (compareLoadGen.current === generation) patchSession(tabId, { historyDiff });
          }),
      );
    } else if (history?.path && current.historyDiff && !current.historyDiff.binary) {
      const generation = ++historyLoadGen.current;
      jobs.push(
        gitApi.getCommitDiff(repoPath, history.id, history.path, ws).then((historyDiff) => {
          patchSession(tabId, { historyDiff }, generation);
        }),
      );
    }
    const stash = current.stashSelection;
    if (stash?.path && current.stashDiff && !current.stashDiff.binary) {
      const generation = ++stashLoadGen.current;
      jobs.push(
        gitApi.getStashDiff(repoPath, stash.id, stash.path, ws).then((stashDiff) => {
          patchSession(tabId, { stashDiff }, generation, "stash");
        }),
      );
    }
    try {
      await Promise.all(jobs);
    } catch (error) {
      reportError(error);
    }
  }, [activeRepoPath, patchSession]);

  const setDiffOptions = useCallback(
    async (options: { split?: boolean; ignoreWhitespace?: boolean }) => {
      const before = prefsRef.current;
      await updatePrefs({
        ...before,
        diffSplit: options.split ?? before.diffSplit,
        diffIgnoreWhitespace: options.ignoreWhitespace ?? before.diffIgnoreWhitespace,
      });
      if (
        options.ignoreWhitespace !== undefined &&
        options.ignoreWhitespace !== before.diffIgnoreWhitespace
      ) {
        await reloadDiffs();
      }
    },
    [reloadDiffs, updatePrefs],
  );

  const updatePanelLayout = useCallback((id: PanelLayoutId, layout: PanelLayout) => {
    const current = prefsRef.current;
    if (sameLayout(current.panelLayouts[id], layout)) return;
    prefsRef.current = normalizePrefs({
      ...current,
      panelLayouts: { ...current.panelLayouts, [id]: layout },
    });
    if (persistPrefsTimer.current !== null) window.clearTimeout(persistPrefsTimer.current);
    persistPrefsTimer.current = window.setTimeout(() => {
      persistPrefsTimer.current = null;
      const next = prefsRef.current;
      void gitApi.setPrefs(next).then(() => setPrefs(next)).catch(() => undefined);
    }, 400);
  }, []);

  const state = useMemo<GitState>(
    () => ({
      recents,
      tabs,
      activeTabId,
      activeTab,
      snapshot: session?.snapshot ?? null,
      commits: session?.commits ?? NO_COMMITS,
      commitsHasMore: session?.commitsHasMore ?? true,
      commitsLoading: session?.commitsLoading ?? false,
      historyRevs: session?.historyRevs ?? NO_REVS,
      historyExpanded: session?.historyExpanded ?? null,
      view: session?.view ?? "changes",
      changeSelection: session?.changeSelection ?? null,
      historySelection: session?.historySelection ?? null,
      changeDiff: session?.changeDiff ?? null,
      historyDiff: session?.historyDiff ?? null,
      commitDetails: session?.commitDetails ?? null,
      comparison: session?.comparison ?? null,
      stashSelection: session?.stashSelection ?? null,
      stashDetails: session?.stashDetails ?? null,
      stashDiff: session?.stashDiff ?? null,
      stashes: session?.snapshot?.stashes ?? NO_STASHES,
      fileFocus: session?.fileFocus ?? null,
      commitDraft: session?.commitDraft ?? null,
      openPanel,
      prefs,
      gitMissing,
      loading,
      publishPrompt,
    }),
    [activeTab, activeTabId, gitMissing, loading, openPanel, prefs, publishPrompt, recents, session, tabs],
  );

  // Every action reads refs rather than render state, so this object keeps its
  // identity and the context value never changes after mount.
  const actions = useMemo<GitActions>(
    () => ({
      setView,
      setOpenPanel,
      showFile,
      openRepoFile,
      revealRepoFile,
      openInEditor,
      openDifftool,
      runMergetool,
      ignorePaths,
      beginActivity,
      endActivity,
      setActiveTab,
      closeTab,
      reorderTabs,
      openFolder,
      openPath,
      cloneRepository,
      revealRepo,
      openTerminal,
      ensureBranches,
      ensureHistory,
      loadMoreCommits,
      setHistoryRevs,
      setHistoryExpanded,
      forgetRecent,
      closeRepo,
      selectChange,
      selectCommit,
      selectCommitFile,
      openComparison,
      swapComparison,
      closeComparison,
      selectCompareFile,
      selectStash,
      selectStashFile,
      closeFile,
      closeStash,
      closeCommit,
      stage,
      unstage,
      discard,
      applyLines,
      commit,
      undoLastCommit,
      checkoutDetached,
      updateSubmodules,
      checkoutBranch,
      fetchRemote,
      fetchAllRemotes,
      pullRemote,
      pushRemote,
      dismissPublish,
      confirmPublish,
      createBranch,
      createTag,
      deleteTag,
      pushTag,
      deleteRemoteTag,
      deleteBranch,
      revertCommit,
      cherryPickCommit,
      rebaseOnto,
      rebaseInteractive,
      rebaseContinue,
      rebaseSkip,
      rebaseAbort,
      mergeRef,
      operationContinue,
      operationAbort,
      resolveConflict,
      saveConflict,
      resetCommit,
      createPatch,
      applyPatch,
      addRemote,
      deleteRemote,
      stashSave,
      stashApply,
      stashPop,
      stashDrop,
      updatePrefs,
      setDiffOptions,
      updatePanelLayout,
    }),
    [
      setView,
      setOpenPanel,
      showFile,
      openRepoFile,
      revealRepoFile,
      openInEditor,
      openDifftool,
      runMergetool,
      ignorePaths,
      beginActivity,
      endActivity,
      setActiveTab,
      closeTab,
      reorderTabs,
      openFolder,
      openPath,
      cloneRepository,
      revealRepo,
      openTerminal,
      ensureBranches,
      ensureHistory,
      loadMoreCommits,
      setHistoryRevs,
      setHistoryExpanded,
      forgetRecent,
      closeRepo,
      selectChange,
      selectCommit,
      selectCommitFile,
      openComparison,
      swapComparison,
      closeComparison,
      selectCompareFile,
      selectStash,
      selectStashFile,
      closeFile,
      closeStash,
      closeCommit,
      stage,
      unstage,
      discard,
      applyLines,
      commit,
      undoLastCommit,
      checkoutDetached,
      updateSubmodules,
      checkoutBranch,
      fetchRemote,
      fetchAllRemotes,
      pullRemote,
      pushRemote,
      dismissPublish,
      confirmPublish,
      createBranch,
      createTag,
      deleteTag,
      pushTag,
      deleteRemoteTag,
      deleteBranch,
      revertCommit,
      cherryPickCommit,
      rebaseOnto,
      rebaseInteractive,
      rebaseContinue,
      rebaseSkip,
      rebaseAbort,
      mergeRef,
      operationContinue,
      operationAbort,
      resolveConflict,
      saveConflict,
      resetCommit,
      createPatch,
      applyPatch,
      addRemote,
      deleteRemote,
      stashSave,
      stashApply,
      stashPop,
      stashDrop,
      updatePrefs,
      setDiffOptions,
      updatePanelLayout,
    ],
  );

  const [store] = useState(() => createStore(state));
  useLayoutEffect(() => {
    store.set(state);
  }, [state, store]);
  const context = useMemo(() => ({ store, actions }), [actions, store]);

  return (
    <GitContext.Provider value={context}>
      <ActivityContext.Provider value={activities}>{children}</ActivityContext.Provider>
    </GitContext.Provider>
  );
}

/**
 * Reads the named state fields and actions. The component re-renders only
 * when one of the named state fields changes identity; actions never change.
 */
export function useGitPick<K extends keyof GitContextValue>(keys: readonly K[]): Pick<GitContextValue, K> {
  const context = useContext(GitContext);
  if (!context) {
    throw new Error("useGitPick must be used within GitProvider");
  }
  const { store, actions } = context;
  const keyText = keys.join(",");
  const select = useCallback(
    (current: GitState) => {
      const picked = {} as Pick<GitContextValue, K>;
      for (const name of keyText.split(",") as K[]) {
        picked[name] = (
          name in actions ? actions[name as keyof GitActions] : current[name as keyof GitState]
        ) as GitContextValue[K];
      }
      return picked;
    },
    [actions, keyText],
  );
  return useSyncExternalStoreWithSelector(store.subscribe, store.get, store.get, select, shallowEqual);
}

function shallowEqual<T extends object>(left: T, right: T) {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}

/**
 * Subscribes to one value derived from state. The selector must return a
 * primitive or an existing reference, since results are compared with Object.is.
 */
export function useGitSelect<T>(selector: (state: GitState) => T): T {
  const context = useContext(GitContext);
  if (!context) {
    throw new Error("useGitSelect must be used within GitProvider");
  }
  const { store } = context;
  return useSyncExternalStoreWithSelector(store.subscribe, store.get, store.get, selector);
}

export function useActivities() {
  return useContext(ActivityContext);
}

function patchFileName(commit: CommitSummary) {
  const slug = (commit.summary || commit.shortId)
    .toLowerCase()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${commit.shortId}-${slug || "commit"}.patch`;
}
