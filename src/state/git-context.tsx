import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { emptyBinaryDiff, errorMessage, expandHistoryRevs, gitApi } from "@/lib/git";
import { pathSegments, sameRepoPath } from "@/lib/format";
import { defaultPrefs, normalizePrefs, sameLayout } from "@/lib/prefs";
import type {
  Activity,
  AppPrefs,
  AppSession,
  PanelLayout,
  PanelLayoutId,
  CommitDetails,
  CommitSummary,
  FileDiff,
  RecentRepo,
  Selection,
  StashInfo,
  WorkspaceSnapshot,
} from "@/types/git";

export type View = "changes" | "history" | "stash";
export type ResetMode = "soft" | "mixed" | "hard" | "merge" | "keep";
export const WELCOME_TAB_ID = "welcome";
export const COMMIT_PAGE = 80;

function defaultFetchRemote(snapshot: WorkspaceSnapshot | null | undefined) {
  const names = snapshot?.remotes.map((remote) => remote.name) ?? [];
  const upstream = snapshot?.repo.upstream;
  if (upstream) {
    const match = names
      .filter((name) => upstream === name || upstream.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (match) return match;
    const slash = upstream.indexOf("/");
    if (slash > 0) return upstream.slice(0, slash);
  }
  return names.includes("origin") ? "origin" : undefined;
}

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
  historyRevs: string[];
  historyExpanded: string[] | null;
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

function emptySession(
  path: string,
  historyRevs: string[] = [],
  historyExpanded: string[] | null = null,
): RepoSession {
  return {
    path,
    snapshot: null,
    commits: [],
    commitsLoaded: false,
    commitsHasMore: true,
    commitsLoading: false,
    historyRevs,
    historyExpanded,
    view: "changes",
    changeSelection: null,
    historySelection: null,
    changeDiff: null,
    historyDiff: null,
    commitDetails: null,
  };
}

function lookupHistoryRevs(map: Record<string, string[]>, path: string): string[] {
  return lookupPathList(map, path) ?? [];
}

function lookupPathList(map: Record<string, string[]>, path: string): string[] | null {
  if (Object.prototype.hasOwnProperty.call(map, path)) return map[path] ?? [];
  const key = Object.keys(map).find((item) => sameRepoPath(item, path));
  return key ? (map[key] ?? []) : null;
}

function keepRemoteBranches(
  previous: WorkspaceSnapshot | null | undefined,
  next: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (next.branches.remote.length > 0 || !previous?.branches.remote.length) return next;
  return {
    ...next,
    branches: {
      ...next.branches,
      remote: previous.branches.remote,
    },
  };
}

function historyGraphChanged(
  previous: WorkspaceSnapshot | null | undefined,
  next: WorkspaceSnapshot,
) {
  const before = previous?.repo;
  const after = next.repo;
  if (!before) return true;
  return (
    before.headId !== after.headId ||
    before.ahead !== after.ahead ||
    before.behind !== after.behind ||
    before.upstream !== after.upstream
  );
}

function sameRevs(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function afterPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function progressFromGitLine(line: string): number | undefined {
  const match = line.match(/(\d+(?:\.\d+)?)%/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function repoNameFromPath(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] || path;
}

function tabFromPath(path: string, name?: string): RepoTab {
  return {
    id: repoTabId(path),
    kind: "repo",
    path,
    name: name || repoNameFromPath(path),
    branch: null,
    isDetached: false,
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
  historyRevs: string[];
  historyExpanded: string[] | null;
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
  setHistoryRevs: (revs: string[]) => void;
  setHistoryExpanded: (ids: string[]) => void;
  forgetRecent: (path: string) => Promise<void>;
  closeRepo: () => void;
  selectChange: (path: string, staged: boolean) => Promise<void>;
  selectCommit: (id: string) => Promise<void>;
  selectCommitFile: (id: string, path: string) => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (message: string, amend?: boolean) => Promise<boolean>;
  checkoutBranch: (name: string) => Promise<void>;
  fetchRemote: (remote?: string) => Promise<void>;
  fetchAllRemotes: () => Promise<void>;
  pullRemote: () => Promise<void>;
  pushRemote: (force?: boolean) => Promise<void>;
  createBranch: (name: string, switchTo: boolean, start?: string) => Promise<boolean>;
  deleteBranch: (name: string) => Promise<boolean>;
  revertCommit: (oid: string) => Promise<boolean>;
  cherryPickCommit: (oid: string) => Promise<boolean>;
  resetCommit: (oid: string, mode: ResetMode) => Promise<boolean>;
  createPatch: (commit: CommitSummary) => Promise<void>;
  applyPatch: () => Promise<void>;
  addRemote: (name: string, url: string) => Promise<boolean>;
  deleteRemote: (name: string) => Promise<boolean>;
  stashSave: (message: string, includeUntracked: boolean) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashPop: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  updatePrefs: (prefs: AppPrefs) => Promise<AppPrefs>;
  updatePanelLayout: (id: PanelLayoutId, layout: PanelLayout) => void;
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
  const prefsRef = useRef(prefs);
  const persistPrefsTimer = useRef<number | null>(null);

  const tabsRef = useRef(tabs);
  const sessionsRef = useRef(sessions);
  const activeTabIdRef = useRef(activeTabId);
  const openingPathsRef = useRef(new Set<string>());
  const historyRevsMapRef = useRef<Record<string, string[]>>({});
  const historyExpandedMapRef = useRef<Record<string, string[]>>({});
  const historyLoadGen = useRef(0);
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
    (tabId: string, patch: Partial<RepoSession>, generation?: number) => {
      setSessions((current) => {
        if (generation !== undefined && historyLoadGen.current !== generation) return current;
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

    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    setTabs(nextTabs);
    setActiveTabId(activeId);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [recentsList, session, loadedPrefs] = await Promise.all([
          gitApi.listRecents(),
          gitApi.loadSession(),
          gitApi.getPrefs().catch(() => defaultPrefs),
        ]);
        const nextPrefs = normalizePrefs(loadedPrefs);
        prefsRef.current = nextPrefs;
        setPrefs(nextPrefs);
        setRecents(recentsList);
        restoreSession(session, recentsList);
      } catch (error) {
        toast.error(errorMessage(error));
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
    void listen<{ id: string; line: string }>("git-progress", (event) => {
      const progress = progressFromGitLine(event.payload.line);
      setActivities((current) =>
        current.map((item) =>
          item.id === event.payload.id
            ? { ...item, detail: event.payload.line, progress: progress ?? item.progress }
            : item,
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

  const hydrateRepo = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "repo") return;
      if (sessionsRef.current[tabId]?.snapshot) return;

      const pendingKey = tab.path.toLowerCase();
      if (openingPathsRef.current.has(pendingKey)) return;
      openingPathsRef.current.add(pendingKey);
      setOpening(true);
      try {
        const snapshot = await runActivity("Opening repository", tab.path, () =>
          gitApi.openRepository(tab.path),
        );
        if (!tabsRef.current.some((item) => item.id === tabId)) return;
        setSessions((current) => {
          const next = {
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
          };
          sessionsRef.current = next;
          return next;
        });
        syncTabMeta(tabId, snapshot);
        setRecents(await gitApi.listRecents());
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        openingPathsRef.current.delete(pendingKey);
        setOpening(openingPathsRef.current.size > 0);
      }
    },
    [runActivity, syncTabMeta],
  );

  const setActiveTab = useCallback(
    (id: string) => {
      setActiveTabId(id);
      void hydrateRepo(id);
    },
    [hydrateRepo],
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
    setOpening(true);
    try {
      const snapshot = await runActivity("Opening repository", path, () =>
        gitApi.openRepository(path),
      );
      const tab = findRepoTab(tabsRef.current, snapshot.repo.path) ?? tabFromSnapshot(snapshot);
      setSessions((current) => {
        const next = {
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
        };
        sessionsRef.current = next;
        return next;
      });
      setTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
      setActiveTabId(tab.id);
      setRecents(await gitApi.listRecents());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      openingPathsRef.current.delete(pendingKey);
      setOpening(openingPathsRef.current.size > 0);
    }
  }, [runActivity, setActiveTab]);

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
      toast.error(errorMessage(error));
    }
  }, [activeRepoPath, patchSession]);

  const historyEpochRef = useRef<Record<string, number>>({});

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
      patchSession(tabId, { commitsLoading: true });
      try {
        const page = await runActivity(
          reset ? "Loading history" : "Loading earlier history",
          current.snapshot?.repo.name,
          () => gitApi.getCommits(repoPath, COMMIT_PAGE, skip, undefined, revs),
        );
        if (historyEpochRef.current[tabId] !== epoch) return;
        const latest = sessionsRef.current[tabId];
        patchSession(tabId, {
          commits: reset ? page : [...(latest?.commits ?? []), ...page],
          commitsLoaded: true,
          commitsHasMore: page.length === COMMIT_PAGE,
          commitsLoading: false,
        });
      } catch (error) {
        if (historyEpochRef.current[tabId] !== epoch) return;
        patchSession(tabId, { commitsLoading: false });
        toast.error(errorMessage(error));
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
      sessionsRef.current = {
        ...sessionsRef.current,
        [tabId]: { ...current, historyRevs: next, commitsLoaded: false, commitsHasMore: true },
      };
      patchSession(tabId, {
        historyRevs: next,
        commitsLoaded: false,
        commitsHasMore: true,
      });
      persistSession(tabsRef.current, activeTabIdRef.current);
      if (sessionsRef.current[tabId]?.view === "history") {
        void loadHistoryPage(tabId, true);
      }
    },
    [bumpHistoryEpoch, loadHistoryPage, patchSession, persistSession],
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

  const refreshRepo = useCallback(
    async (path: string) => {
      const tab = findRepoTab(tabsRef.current, path);
      if (!tab) return;
      const current = sessionsRef.current[tab.id];
      try {
        const snapshot = keepRemoteBranches(current?.snapshot, await gitApi.refreshWorkspace(path));
        const graphChanged = historyGraphChanged(current?.snapshot, snapshot);
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
        });
        if (graphChanged) {
          invalidateHistory(tab.id, current?.view === "history");
        }
      } catch {
        // Watch refreshes stay quiet when a repo is mid-write.
      }
    },
    [invalidateHistory, patchSession],
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
        const historyDiff = await gitApi.getCommitDiff(repoPath, id, first.path);
        if (historyLoadGen.current !== generation) return;
        startTransition(() => {
          patchSession(tabId, { historyDiff }, generation);
        });
        await afterPaint();
      } catch (error) {
        if (historyLoadGen.current !== generation) return;
        patchSession(tabId, { commitDetails: null, historyDiff: null }, generation);
        toast.error(errorMessage(error));
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
        const historyDiff = await gitApi.getCommitDiff(repoPath, id, path);
        if (historyLoadGen.current !== generation) return;
        startTransition(() => {
          patchSession(tabId, { commitDetails: details, historyDiff }, generation);
        });
        await afterPaint();
      } catch (error) {
        if (historyLoadGen.current !== generation) return;
        patchSession(tabId, { historyDiff: null }, generation);
        toast.error(errorMessage(error));
      } finally {
        endActivity(activityId);
      }
    },
    [activeRepoPath, beginActivity, endActivity, patchActivity, patchSession],
  );

  const runMutation = useCallback(
    async (
      label: string,
      action: (repoPath: string, activityId: string) => Promise<WorkspaceSnapshot>,
      success?: string,
    ) => {
      const repoPath = activeRepoPath();
      const tabId = activeTabIdRef.current;
      if (!repoPath) return false;
      const current = sessionsRef.current[tabId];
      const changeSelection = current?.changeSelection ?? null;
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
                commitsLoaded: false,
                commitsHasMore: true,
              }
            : {}),
        });
        if (next.headChanged && sessionsRef.current[tabId]?.view === "history") {
          void loadHistoryPage(tabId, true);
        }
        if (success) toast.success(success);
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        return false;
      }
    },
    [activeRepoPath, loadHistoryPage, patchSession, runActivity],
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
      const ok = await runMutation(
        amend ? "Amending commit" : "Creating commit",
        (repoPath) => gitApi.commit(repoPath, message, amend),
        amend ? "Amended commit" : "Created commit",
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
      if (sessionsRef.current[tabId]?.view === "history") {
        void loadHistoryPage(tabId, true);
      }
    },
    [loadHistoryPage, patchSession, runMutation],
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

  const fetchRemote = useCallback(
    async (remote?: string) => {
      const named = remote?.trim();
      const target =
        named || defaultFetchRemote(sessionsRef.current[activeTabIdRef.current]?.snapshot);
      const ok = await runMutation(
        target ? `Fetching ${target}` : "Fetching",
        (repoPath, activityId) => gitApi.fetchRemote(repoPath, activityId, named || undefined),
        target ? `Fetched ${target}` : "Fetched",
      );
      await refreshAfterFetch(ok);
    },
    [refreshAfterFetch, runMutation],
  );

  const fetchAllRemotes = useCallback(async () => {
    const ok = await runMutation(
      "Fetching all remotes",
      (repoPath, activityId) => gitApi.fetchRemote(repoPath, activityId, undefined, true),
      "Fetched all remotes",
    );
    await refreshAfterFetch(ok);
  }, [refreshAfterFetch, runMutation]);

  const pullRemote = useCallback(async () => {
    const ok = await runMutation(
      "Pulling",
      (repoPath, activityId) => gitApi.pullRemote(repoPath, activityId),
      "Pulled",
    );
    await ensureBranches(true);
    if (ok) invalidateHistory(activeTabIdRef.current, sessionsRef.current[activeTabIdRef.current]?.view === "history");
  }, [ensureBranches, invalidateHistory, runMutation]);

  const pushRemote = useCallback(async (force = false) => {
    await runMutation(
      force ? "Force pushing" : "Pushing",
      (repoPath, activityId) => gitApi.pushRemote(repoPath, activityId, force),
      force ? "Force pushed" : "Pushed",
    );
  }, [runMutation]);

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
      if (sessionsRef.current[tabId]?.view === "history") {
        void loadHistoryPage(tabId, true);
      }
      return true;
    },
    [loadHistoryPage, patchSession, runMutation],
  );

  const deleteBranch = useCallback(
    async (name: string) => {
      const tabId = activeTabIdRef.current;
      const current = sessionsRef.current[tabId];
      const wasRemote = current?.snapshot?.branches.remote.some((branch) => branch.name === name) ?? false;
      const ok = await runMutation(
        `Deleting ${name}`,
        (repoPath, activityId) => gitApi.deleteBranch(repoPath, name, activityId),
        `Deleted ${name}`,
      );
      if (!ok) return false;
      const next = sessionsRef.current[tabId];
      if (next?.historyRevs.includes(name)) {
        setHistoryRevs(next.historyRevs.filter((rev) => rev !== name));
      }
      if (wasRemote) await ensureBranches(true);
      return true;
    },
    [ensureBranches, runMutation, setHistoryRevs],
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
        ...(dirty ? { view: "changes" } : {}),
        ...(headChanged
          ? {
              commitsLoaded: false,
              commitsHasMore: true,
            }
          : {}),
      });
      if (headChanged && sessionsRef.current[tabId]?.view === "history") {
        void loadHistoryPage(tabId, true);
      }
    } catch {
      /* the original error is already shown */
    }
  }, [activeRepoPath, loadHistoryPage, patchSession]);

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
        toast.error(errorMessage(error));
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
      );
      const tabId = activeTabIdRef.current;
      patchSession(tabId, {
        commitsLoaded: false,
        commitsHasMore: true,
      });
      if (sessionsRef.current[tabId]?.view === "history") {
        void loadHistoryPage(tabId, true);
      }
      await ensureBranches(true);
      return true;
    },
    [ensureBranches, loadHistoryPage, patchSession, runMutation],
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
      setSessions((current) => {
        const existing = current[tabId];
        const snapshot = existing?.snapshot;
        if (!existing || !snapshot) return current;
        const next = {
          ...current,
          [tabId]: {
            ...existing,
            snapshot: {
              ...snapshot,
              remotes: snapshot.remotes.filter((remote) => remote.name !== name),
              branches: {
                ...snapshot.branches,
                remote: snapshot.branches.remote.filter((branch) => !branch.name.startsWith(prefix)),
              },
            },
          },
        };
        sessionsRef.current = next;
        return next;
      });
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
    [ensureBranches, runMutation, setHistoryExpanded, setHistoryRevs, setSessions],
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

  const flushPrefs = useCallback(async (next: AppPrefs) => {
    if (persistPrefsTimer.current !== null) {
      window.clearTimeout(persistPrefsTimer.current);
      persistPrefsTimer.current = null;
    }
    const saved = normalizePrefs(await gitApi.setPrefs(next));
    prefsRef.current = saved;
    setPrefs(saved);
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
      historyRevs: session?.historyRevs ?? [],
      historyExpanded: session?.historyExpanded ?? null,
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
      setActiveTab,
      closeTab,
      reorderTabs,
      openFolder,
      openPath,
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
      stage,
      unstage,
      discard,
      commit,
      checkoutBranch,
      fetchRemote,
      fetchAllRemotes,
      pullRemote,
      pushRemote,
      createBranch,
      deleteBranch,
      revertCommit,
      cherryPickCommit,
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
      updatePanelLayout,
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
      setActiveTab,
      closeTab,
      reorderTabs,
      openFolder,
      openPath,
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
      stage,
      unstage,
      discard,
      commit,
      checkoutBranch,
      fetchRemote,
      fetchAllRemotes,
      pullRemote,
      pushRemote,
      createBranch,
      deleteBranch,
      revertCommit,
      cherryPickCommit,
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
      updatePanelLayout,
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
