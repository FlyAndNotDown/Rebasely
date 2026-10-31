import { t, useTranslation } from "@/i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { P4ConnectionDialog } from "@/components/p4/p4-connection-dialog";
import { P4LoginDialog } from "@/components/p4/p4-login-dialog";
import { P4WorkspaceDialog } from "@/components/p4/p4-workspace-dialog";
import { errorMessage } from "@/lib/git";
import { depotBase, P4_LOGIN, P4_MISSING, p4Api, syncSummary } from "@/lib/p4";
import { sameRepoPath } from "@/lib/format";
import { useGitPick } from "@/state/git-context";
import { repoTabId, type RepoTab } from "@/state/session";
import { defaultChange, fileKey, refreshPendingSession, sameP4Connection, showP4OperationResult, shownFile, updateP4Session, usableP4Session, type P4ResolveRequest, type P4Session as Session, type P4View } from "@/state/p4-session";
import { pendingDiffRequest, pendingRefreshRequest, withP4Login } from "@/state/p4-requests";
import { acquireP4Mutation, invalidateP4Session } from "@/state/p4-mutations";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import type { FileDiff } from "@/types/git";
import type {
  P4Auth,
  P4ChangePage,
  P4Changelist,
  P4Connection,
  P4DirEntry,
  P4FileSearch,
  P4GetRevision,
  P4IntegrateRequest,
  P4UndoRequest,
  P4OperationPreview,
  P4ResolveView,
  P4Revision,
  P4StreamOption,
} from "@/types/p4";

export type { P4View };

const OPEN_SETTINGS_EVENT = "rebasely-open-settings";

class LoginCancelled extends Error {
  constructor() {
    super("Login cancelled");
  }
}

interface P4ContextValue {
  view: P4View;
  setView: (view: P4View) => void;
  connection: P4Connection | null;
  pending: P4Changelist[];
  loading: boolean;
  busy: boolean;
  busyLabel: string;
  busyKind: "submit" | null;
  error: string | null;
  selectedChange: string;
  selectedFile: string | null;
  selectedShelved: boolean;
  description: string;
  setDescription: (value: string) => void;
  diff: FileDiff | null;
  diffLoading: boolean;
  submitted: P4Changelist[];
  submittedLoading: boolean;
  submittedHasMore: boolean;
  selectedSubmitted: string | null;
  submittedDetail: P4Changelist | null;
  submittedDiffs: FileDiff[];
  refresh: (quiet?: boolean) => Promise<void>;
  selectChange: (id: string) => void;
  selectFile: (depotPath: string | null, shelved?: boolean) => void;
  submitSelected: () => Promise<void>;
  saveSelected: () => Promise<void>;
  createChange: (description: string) => Promise<boolean>;
  deleteChange: (changeId: string) => Promise<boolean>;
  renameFile: (source: string, destination: string) => Promise<boolean>;
  previewIntegrate: (request: P4IntegrateRequest) => Promise<P4OperationPreview>;
  applyIntegrate: (request: P4IntegrateRequest, preview: P4OperationPreview) => Promise<string>;
  previewUndo: (request: P4UndoRequest) => Promise<P4OperationPreview>;
  applyUndo: (request: P4UndoRequest, preview: P4OperationPreview) => Promise<string>;
  resolveRequest: P4ResolveRequest | null;
  dismissResolveRequest: (id: number) => void;
  lockFiles: (files: { change: string; path: string }[], locked: boolean) => Promise<void>;
  moveFiles: (depotPaths: string[], changeId: string) => Promise<void>;
  placeFiles: (
    files: { change: string; path: string; shelved: boolean }[],
    targetChange: string,
    shelf: boolean,
  ) => Promise<void>;
  revertPaths: (paths: string[], wipe?: string[]) => Promise<void>;
  shelveFiles: (files: { change: string; path: string }[]) => Promise<boolean>;
  shelveSelected: () => Promise<void>;
  unshelveSelected: () => Promise<void>;
  deleteSelectedShelf: () => Promise<void>;
  resolveView: (path: string) => Promise<P4ResolveView | null>;
  resolveAccept: (path: string, mode: "yours" | "theirs" | "merge") => Promise<boolean>;
  revertUnchanged: () => Promise<void>;
  sync: (paths?: string[]) => Promise<void>;
  getRevision: (request: P4GetRevision) => Promise<string>;
  filesEpoch: number;
  reconcile: () => Promise<void>;
  fileAction: (action: "edit" | "add" | "delete", paths: string[]) => Promise<void>;
  loadSubmitted: (more?: boolean) => Promise<void>;
  submittedUser: string;
  submittedClient: string;
  setSubmittedFilter: (user: string, client: string) => void;
  listUsers: () => Promise<string[]>;
  listClients: (user: string) => Promise<string[]>;
  listStreams: () => Promise<P4StreamOption[]>;
  selectSubmitted: (id: string) => void;
  listDir: (relative: string) => Promise<P4DirEntry[]>;
  listDepot: (path: string) => Promise<P4DirEntry[]>;
  searchDepot: (query: string) => Promise<P4FileSearch | null>;
  filelog: (path: string) => Promise<P4Revision[]>;
  revisionDiff: (depotPath: string, rev: string) => Promise<FileDiff | null>;
  searchSubmitted: (
    query: string,
    before: number | null,
    matchLimit: number,
    scanLimit: number,
  ) => Promise<P4ChangePage | null>;
  reconnect: () => void;
  connectionOpen: boolean;
  setConnectionOpen: (open: boolean) => void;
  saveConnection: (edit: P4Auth & { client: string }) => Promise<void>;
  workspaceOpen: boolean;
  setWorkspaceOpen: (open: boolean) => void;
  saveWorkspace: (root: string, stream: string) => Promise<void>;
}

const P4Context = createContext<P4ContextValue | null>(null);

export function P4Provider({ children }: { children: ReactNode }) {
  const language = useTranslation().i18n.resolvedLanguage;
  const { activeTab, beginActivity, endActivity, setTabMeta, retargetRepoTab, refreshRecents, prefs } = useGitPick([
    "activeTab",
    "beginActivity",
    "endActivity",
    "setTabMeta",
    "retargetRepoTab",
    "refreshRecents",
    "prefs",
  ]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedBusy, setSubmittedBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [mutationLabels, setMutationLabels] = useState<ReadonlyMap<string, { label: string; kind: "submit" | null }>>(() => new Map());
  const mutationOwners = useRef(new Set<string>());
  const resolveRequestId = useRef(0);
  const lockMutation = useCallback((owner: Session, label: string, kind: "submit" | null = null) => {
    const release = acquireP4Mutation(mutationOwners.current, owner.tabId);
    if (!release) return null;
    setMutationLabels((labels) => new Map(labels).set(owner.tabId, { label, kind }));
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      release();
      setMutationLabels((labels) => {
        const next = new Map(labels);
        next.delete(owner.tabId);
        return next;
      });
    };
  }, []);
  const [loginOpen, setLoginOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [filesEpoch, setFilesEpoch] = useState(0);
  const bumpFiles = useCallback(() => setFilesEpoch((value) => value + 1), []);
  const cache = useRef(new Map<string, Session>());
  const generation = useRef(0);
  const diffTokens = useRef(new Map<string, number>());
  const pendingTokens = useRef(new Map<string, number>());
  const submittedTokens = useRef(new Map<string, number>());
  const refreshing = useRef(new Set<string>());
  const sessionRef = useRef(session);
  const loginRef = useRef<{ resolve: (value: string | null) => void } | null>(null);
  const activeTabRef = useRef(activeTab);
  const activePerforceId = activeTab.kind === "repo" && activeTab.vcs === "perforce" ? activeTab.id : "";
  const visibleSession = usableP4Session(session, activePerforceId, loading, error);
  const submittedLoading = submittedBusy.has(`${activePerforceId}:list`) || submittedBusy.has(`${activePerforceId}:detail`);
  const [attempt, setAttempt] = useState(0);
  const [loginTarget, setLoginTarget] = useState({ client: "", port: "" });
  const reconnect = useCallback(() => {
    sessionRef.current = null;
    setLoading(true);
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  useLayoutEffect(() => {
    activeTabRef.current = activeTab;
    const candidate = session?.tabId === activePerforceId ? session : cache.current.get(activePerforceId) ?? null;
    sessionRef.current = usableP4Session(candidate, activePerforceId, loading, error);
  }, [activePerforceId, activeTab, error, loading, session]);

  const askPassword = useCallback((connection: P4Connection) => {
    setLoginTarget({ client: connection.client, port: connection.port });
    return new Promise<string | null>((resolve) => {
      loginRef.current?.resolve(null);
      loginRef.current = { resolve };
      setLoginOpen(true);
    });
  }, []);

  const finishLogin = useCallback((password: string | null) => {
    const pending = loginRef.current;
    loginRef.current = null;
    setLoginOpen(false);
    pending?.resolve(password);
  }, []);

  const guard = useCallback(
    async <T,>(connection: P4Connection, fn: () => Promise<T>): Promise<T> => {
      return withP4Login(fn, async () => {
        const current = sessionRef.current;
        if (!current || !sameP4Connection(current.connection, connection)) throw new LoginCancelled();
        const password = await askPassword(connection);
        if (!password) throw new LoginCancelled();
        const latest = sessionRef.current;
        if (!latest || !sameP4Connection(latest.connection, connection)) throw new LoginCancelled();
        await p4Api.login(connection, password);
      });
    },
    [askPassword],
  );

  const report = useCallback((caught: unknown) => {
    if (caught instanceof LoginCancelled) return;
    const message = errorMessage(caught);
    if (!message) return;
    if (message === P4_MISSING) {
      toast.error(t("desktop.dependencies.p4Missing"), {
        id: "p4-missing",
        action: {
          label: t("p4.settings"),
          onClick: () => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT)),
        },
      });
      return;
    }
    toast.error(p4DisplayError(message));
  }, []);

  const remember = useCallback((next: Session) => {
    cache.current.set(next.tabId, next);
    sessionRef.current = next;
    setSession(next);
  }, []);

  const updateSession = useCallback((tabId: string, update: (current: Session) => Session) => {
    const next = updateP4Session(cache.current, tabId, update);
    if (next && activeTabRef.current.id === tabId && sessionRef.current?.tabId === tabId) {
      sessionRef.current = next;
      setSession(next);
    }
    return next;
  }, []);

  const patch = useCallback((update: Partial<Session>) => {
    const current = sessionRef.current;
    if (!current) return;
    remember({ ...current, ...update });
  }, [remember]);

  const requestDiff = useCallback((current: Session) => {
    const file = current.selectedFile;
    if (!file) return;
    const key = fileKey(current.selectedChange, file, current.selectedShelved);
    if (current.diffFor === key) return;
    const token = nextToken(diffTokens.current, current.tabId);
    void guard(current.connection, pendingDiffRequest(current.connection, current.selectedChange, file, current.selectedShelved))
      .then((diff) => {
        if (token !== diffTokens.current.get(current.tabId)) return;
        const latest = cache.current.get(current.tabId);
        if (!latest || !sameP4Connection(latest.connection, current.connection) ||
          fileKey(latest.selectedChange, latest.selectedFile, latest.selectedShelved) !== key) return;
        updateSession(current.tabId, (value) => ({ ...value, diff, diffFor: key }));
      })
      .catch((caught) => {
        if (token !== diffTokens.current.get(current.tabId)) return;
        const latest = cache.current.get(current.tabId);
        if (!latest || !sameP4Connection(latest.connection, current.connection) ||
          fileKey(latest.selectedChange, latest.selectedFile, latest.selectedShelved) !== key) return;
        updateSession(current.tabId, (value) => ({ ...value, diff: null, diffFor: key }));
        report(caught);
      });
  }, [guard, report, updateSession]);

  useEffect(() => {
    if (!activePerforceId) return;
    const tab = activeTabRef.current;
    if (tab.kind !== "repo" || tab.vcs !== "perforce") return;
    nextToken(pendingTokens.current, tab.id);
    nextToken(diffTokens.current, tab.id);
    nextToken(submittedTokens.current, `${tab.id}:list`);
    nextToken(submittedTokens.current, `${tab.id}:detail`);
    setSubmittedBusy((busy) => withoutKey(withoutKey(busy, `${tab.id}:list`), `${tab.id}:detail`));
    const token = ++generation.current;
    setLoading(true);
    const cached = cache.current.get(tab.id);
    if (cached) {
      sessionRef.current = null;
      setSession(cached);
      setError(null);
    } else {
      sessionRef.current = null;
      setSession(null);
      setLoading(true);
      setError(null);
    }
    void openTab(tab, token);
    async function openTab(target: RepoTab, current: number) {
      try {
        let opened = await p4Api.open(target.path);
        if (generation.current !== current) return;
        if (opened.status === "login") {
          const password = await askPassword(opened.connection);
          if (generation.current !== current) return;
          if (!password) {
            setError(P4_LOGIN);
            setLoading(false);
            return;
          }
          await p4Api.login(opened.connection, password);
          opened = await p4Api.open(opened.connection.root || target.path);
          if (generation.current !== current) return;
          if (opened.status !== "ready") throw new Error(t("p4.perforceRejectedThatPassword"));
        }
        if (opened.status !== "ready") return;
        const name = opened.connection.client || target.name;
        const tabId = repoTabId(opened.connection.root, "perforce");
        if (!sameRepoPath(target.path, opened.connection.root)) {
          retargetRepoTab(target.id, opened.connection.root, name);
        } else {
          setTabMeta(target.id, name);
        }
        const stored = cache.current.get(tabId);
        const previous = stored && sameP4Connection(stored.connection, opened.connection) ? stored : undefined;
        const pending = opened.pending;
        const selectedChange =
          previous && pending.some((change) => change.id === previous.selectedChange)
            ? previous.selectedChange
            : defaultChange(pending);
        const selected = pending.find((change) => change.id === selectedChange);
        const shown = shownFile(selected?.files ?? [], previous ? {
          path: previous.selectedFile,
          shelved: previous.selectedShelved,
        } : undefined);
        const next = refreshPendingSession({
          tabId,
          connection: opened.connection,
          pending: previous?.pending ?? [],
          selectedChange: previous?.selectedChange ?? selectedChange,
          selectedFile: shown.path,
          selectedShelved: shown.shelved,
          description: previous?.description ?? "",
          diff: null,
          diffFor: "",
          submitted: previous?.submitted ?? [],
          submittedHasMore: previous?.submittedHasMore ?? true,
          selectedSubmitted: previous?.selectedSubmitted ?? null,
          submittedDetail: previous?.submittedDetail ?? null,
          submittedDiffs: previous?.submittedDiffs ?? [],
          submittedUser: previous?.submittedUser ?? "",
          submittedClient: previous?.submittedClient ?? "",
          view: previous?.view ?? "pending",
          resolveRequest: previous?.resolveRequest ?? null,
        }, pending);
        cache.current.set(tabId, next);
        if (generation.current !== current) return;
        remember(next);
        requestDiff(next);
        void refreshRecents();
        setError(null);
      } catch (caught) {
        if (generation.current !== current) return;
        setError(errorMessage(caught));
        report(caught);
      } finally {
        if (generation.current === current) setLoading(false);
      }
    }
    return () => {
      generation.current += 1;
      finishLogin(null);
    };
  }, [activePerforceId, attempt, askPassword, finishLogin, refreshRecents, remember, report, requestDiff, retargetRepoTab, setTabMeta]);

  const connection = visibleSession?.connection ?? null;
  const selectedFile = visibleSession?.selectedFile ?? null;
  const selectedShelved = visibleSession?.selectedShelved ?? false;
  const selectedChange = visibleSession?.selectedChange ?? "default";
  const diffKey = connection && selectedFile ? fileKey(selectedChange, selectedFile, selectedShelved) : "";
  const diffLoading = diffKey !== "" && visibleSession?.diffFor !== diffKey;

  const reloadPending = useCallback(async (target: Session, selectId?: string, quiet = false) => {
    const owner = cache.current.get(target.tabId);
    if (!owner || !sameP4Connection(owner.connection, target.connection)) return;
    const token = nextToken(pendingTokens.current, target.tabId);
    const pending = await pendingRefreshRequest(target.connection, quiet, (request) => guard(target.connection, request));
    if (pendingTokens.current.get(target.tabId) !== token) return;
    const latest = cache.current.get(target.tabId);
    if (!latest || !sameP4Connection(latest.connection, target.connection)) return;
    const next = updateSession(target.tabId, (current) => refreshPendingSession(current, pending, selectId, target.selectedChange));
    if (next) requestDiff(next);
  }, [guard, requestDiff, updateSession]);

  const refresh = useCallback(async (quiet = false) => {
    const current = sessionRef.current;
    if (!current || refreshing.current.has(current.tabId)) return;
    refreshing.current.add(current.tabId);
    const id = beginActivity(t("p4.refreshingWorkspace"), current.connection.client);
    try {
      await reloadPending(current, undefined, quiet);
    } catch (caught) {
      if (!quiet) report(caught);
    } finally {
      refreshing.current.delete(current.tabId);
      endActivity(id);
    }
  }, [beginActivity, endActivity, reloadPending, report]);

  useEffect(() => {
    const minutes = prefs.p4RefreshMinutes;
    if (!minutes) return;
    const interval = minutes * 60_000;
    let last = Date.now() - interval + 30_000;
    const timer = window.setInterval(() => {
      const tab = activeTabRef.current;
      if (tab.kind !== "repo" || tab.vcs !== "perforce" || !sessionRef.current) return;
      const now = Date.now();
      if (now - last < interval) return;
      last = now;
      void refresh(true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [prefs.p4RefreshMinutes, refresh]);

  const selectChange = useCallback((id: string) => {
    const current = sessionRef.current;
    if (!current || current.selectedChange === id) return;
    const change = current.pending.find((item) => item.id === id);
    const shown = shownFile(change?.files ?? []);
    patch({
      selectedChange: id,
      selectedFile: shown.path,
      selectedShelved: shown.shelved,
      description: change?.description ?? "",
      diff: null,
      diffFor: "",
    });
    const latest = sessionRef.current;
    if (latest) requestDiff(latest);
  }, [patch, requestDiff]);

  const selectFile = useCallback((depotPath: string | null, shelved = false) => {
    const current = sessionRef.current;
    if (!current || (current.selectedFile === depotPath && current.selectedShelved === shelved)) return;
    patch({ selectedFile: depotPath, selectedShelved: shelved, diff: null, diffFor: "" });
    const latest = sessionRef.current;
    if (latest) requestDiff(latest);
  }, [patch, requestDiff]);

  const setDescription = useCallback((value: string) => {
    patch({ description: value });
  }, [patch]);

  const setView = useCallback((view: P4View) => {
    patch({ view });
  }, [patch]);

  const submitSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.submittingChangelist"), "submit");
    if (!release) return;
    const id = beginActivity(t("p4.submitting"), current.selectedChange);
    try {
      await guard(current.connection, () =>
        p4Api.submit(current.connection, current.selectedChange, current.description),
      );
      toast.success(t("p4.submitted"));
      await reloadPending(current, "default");
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const saveSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.savingChangelist"));
    if (!release) return;
    const id = beginActivity(t("p4.savingChangelist"), current.selectedChange);
    try {
      const saved = await guard(current.connection, () =>
        p4Api.saveChange(current.connection, current.selectedChange, current.description),
      );
      toast.success(current.selectedChange === "default" ? t("p4.createdChange", { id: saved }) : t("p4.descriptionSaved"));
      await reloadPending(current, saved);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const createChange = useCallback(
    async (description: string) => {
      const current = sessionRef.current;
      if (!current) return false;
      const release = lockMutation(current, t("p4.creatingChangelist"));
      if (!release) return false;
      const id = beginActivity(t("p4.creatingChangelist"));
      try {
        const saved = await guard(current.connection, () => p4Api.newChange(current.connection, description));
        toast.success(t("p4.createdChange", { id: saved }));
        await reloadPending(current, saved);
        return true;
      } catch (caught) {
        report(caught);
        return false;
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reloadPending, report],
  );

  const deleteChange = useCallback(async (changeId: string) => {
    const current = sessionRef.current;
    if (!current) return false;
    const release = lockMutation(current, t("p4.deletingChangelist"));
    if (!release) return false;
    const id = beginActivity(t("p4.deletingChangelist"), changeId);
    try {
      await guard(current.connection, () => p4Api.deleteChange(current.connection, changeId));
      await reloadPending(current, "default");
      toast.success(t("p4.deletedChange", { id: changeId }));
      return true;
    } catch (caught) {
      report(caught);
      return false;
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const renameFile = useCallback(async (source: string, destination: string) => {
    const current = sessionRef.current;
    if (!current) return false;
    const release = lockMutation(current, t("p4.movingFile"));
    if (!release) return false;
    const id = beginActivity(t("p4.movingFile"), source);
    try {
      await guard(current.connection, () => p4Api.moveFile(current.connection, source, destination));
      await reloadPending(current);
      bumpFiles();
      toast.success(t("p4.fileMoved"));
      return true;
    } catch (caught) {
      // A failed move can leave a previously unopened file checked out.
      // Refresh its owning session without replacing the operation's error.
      await reloadPending(current).catch(() => {});
      bumpFiles();
      report(caught);
      return false;
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, bumpFiles, report]);

  const previewIntegrate = useCallback(async (request: P4IntegrateRequest) => {
    const current = sessionRef.current;
    if (!current) throw new Error(t("p4-operations.connectionRequired"));
    return guard(current.connection, () => p4Api.previewIntegrate(current.connection, request));
  }, [guard]);

  const previewUndo = useCallback(async (request: P4UndoRequest) => {
    const current = sessionRef.current;
    if (!current) throw new Error(t("p4-operations.connectionRequired"));
    return guard(current.connection, () => p4Api.previewUndo(current.connection, request));
  }, [guard]);

  const showFileOperation = useCallback(async (owner: Session, changeId: string, target: string) => {
    await reloadPending(owner, changeId);
    const latest = cache.current.get(owner.tabId);
    if (!latest || !sameP4Connection(latest.connection, owner.connection)) return;
    const next = updateSession(owner.tabId, (current) => showP4OperationResult(current, target, changeId, ++resolveRequestId.current));
    if (next) requestDiff(next);
    if (activeTabRef.current.id === owner.tabId) bumpFiles();
  }, [reloadPending, updateSession, requestDiff, bumpFiles]);

  const applyIntegrate = useCallback(async (request: P4IntegrateRequest, preview: P4OperationPreview) => {
    const current = sessionRef.current;
    if (!current) throw new Error(t("p4-operations.connectionRequired"));
    const release = lockMutation(current, t("p4-operations.integrate.running"));
    if (!release) throw new Error(t("p4-operations.workspaceBusy"));
    const activity = beginActivity(t("p4-operations.integrate.running"), preview.target, undefined, current.tabId);
    try {
      const output = await guard(current.connection, () => p4Api.applyIntegrate(current.connection, request, preview.fingerprint));
      await showFileOperation(current, request.changeId, preview.target);
      toast.success(t("p4-operations.integrate.completed"));
      return output;
    } catch (caught) {
      await reloadPending(current).catch(() => {});
      if (activeTabRef.current.id === current.tabId) bumpFiles();
      throw caught;
    } finally { endActivity(activity); release(); }
  }, [lockMutation, beginActivity, endActivity, guard, showFileOperation, reloadPending, bumpFiles]);

  const applyUndo = useCallback(async (request: P4UndoRequest, preview: P4OperationPreview) => {
    const current = sessionRef.current;
    if (!current) throw new Error(t("p4-operations.connectionRequired"));
    const release = lockMutation(current, t("p4-operations.undo.running"));
    if (!release) throw new Error(t("p4-operations.workspaceBusy"));
    const activity = beginActivity(t("p4-operations.undo.running"), preview.target, undefined, current.tabId);
    try {
      const output = await guard(current.connection, () => p4Api.applyUndo(current.connection, request, preview.fingerprint));
      await showFileOperation(current, request.changeId, preview.target);
      toast.success(t("p4-operations.undo.completed"));
      return output;
    } catch (caught) {
      await reloadPending(current).catch(() => {});
      if (activeTabRef.current.id === current.tabId) bumpFiles();
      throw caught;
    } finally { endActivity(activity); release(); }
  }, [lockMutation, beginActivity, endActivity, guard, showFileOperation, reloadPending, bumpFiles]);

  const dismissResolveRequest = useCallback((id: number) => {
    const current = sessionRef.current;
    if (current?.resolveRequest?.id === id) updateSession(current.tabId, (value) => ({ ...value, resolveRequest: null }));
  }, [updateSession]);

  const lockFiles = useCallback(async (files: { change: string; path: string }[], locked: boolean) => {
    const current = sessionRef.current;
    if (!current || files.length === 0) return;
    const label = t(locked ? "p4.lock.locking" : "p4.lock.unlocking");
    const release = lockMutation(current, label);
    if (!release) return;
    const id = beginActivity(label);
    try {
      for (const [changeId, paths] of groupPaths(files)) {
        await guard(current.connection, () => p4Api.fileAction(current.connection, locked ? "lock" : "unlock", paths, changeId));
      }
      toast.success(t(locked ? "p4.lock.locked" : "p4.lock.unlocked"));
    } catch (caught) {
      report(caught);
    } finally {
      // Earlier groups may have succeeded even when another changelist failed.
      await reloadPending(current).catch(report);
      bumpFiles();
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, bumpFiles, report]);

  const moveFiles = useCallback(
    async (depotPaths: string[], changeId: string) => {
      const current = sessionRef.current;
      if (!current || depotPaths.length === 0) return;
      const release = lockMutation(current, t("p4.movingFiles"));
      if (!release) return;
      const id = beginActivity(t("p4.movingFiles"));
      try {
        await guard(current.connection, () => p4Api.reopen(current.connection, changeId, depotPaths));
        await reloadPending(current, changeId);
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reloadPending, report],
  );

  const placeFiles = useCallback(
    async (
      files: { change: string; path: string; shelved: boolean }[],
      targetChange: string,
      shelf: boolean,
    ) => {
      const current = sessionRef.current;
      if (!current || files.length === 0) return;
      const shelved = files[0].shelved;
      if (files.some((file) => file.shelved !== shelved)) return;
      if (shelf && targetChange === "default") return;
      if (shelf && shelved && files.every((file) => file.change === targetChange)) return;
      if (!shelf && !shelved && files.every((file) => file.change === targetChange)) return;
      const label = !shelved && !shelf ? t("p4.moving") : shelved && !shelf ? t("p4.unshelving") : t("p4.shelving");
      const release = lockMutation(current, label);
      if (!release) return;
      const id = beginActivity(label, targetChange);
      try {
        await guard(current.connection, async () => {
          if (!shelved && !shelf) {
            const paths = files.filter((file) => file.change !== targetChange).map((file) => file.path);
            await p4Api.reopen(current.connection, targetChange, paths);
            return;
          }
          if (!shelved && shelf) {
            const moving = files.filter((file) => file.change !== targetChange).map((file) => file.path);
            if (moving.length > 0) await p4Api.reopen(current.connection, targetChange, moving);
            await p4Api.shelve(
              current.connection,
              targetChange,
              files.map((file) => file.path),
            );
            return;
          }
          const moving = shelf ? files.filter((file) => file.change !== targetChange) : files;
          for (const [source, paths] of groupPaths(moving)) {
            await p4Api.unshelve(current.connection, source, targetChange, paths);
          }
          if (shelf) {
            await p4Api.shelve(
              current.connection,
              targetChange,
              moving.map((file) => file.path),
            );
          }
        });
        toast.success(!shelved && !shelf ? t("p4.moved") : shelved && !shelf ? t("p4.unshelved") : t("p4.shelved"));
        await reloadPending(current, targetChange);
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reloadPending, report],
  );

  const revertPaths = useCallback(
    async (paths: string[], wipe: string[] = []) => {
      const current = sessionRef.current;
      if (!current || (paths.length === 0 && wipe.length === 0)) return;
      const release = lockMutation(current, t("p4.reverting"));
      if (!release) return;
      const id = beginActivity(t("p4.reverting"));
      try {
        await guard(current.connection, () => p4Api.revert(current.connection, paths, wipe));
        toast.success(t("p4.reverted"));
        await reloadPending(current);
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reloadPending, report],
  );

  const shelveFiles = useCallback(
    async (files: { change: string; path: string }[]) => {
      const current = sessionRef.current;
      const numbered = files.filter((file) => file.change !== "default");
      if (!current || numbered.length === 0) return false;
      const release = lockMutation(current, t("p4.shelving"));
      if (!release) return false;
      const id = beginActivity(t("p4.shelving"));
      try {
        await guard(current.connection, async () => {
          for (const [change, paths] of groupPaths(numbered)) {
            await p4Api.shelve(current.connection, change, paths);
          }
        });
        const skipped = files.length - numbered.length;
        toast.success(skipped > 0 ? t("p4.shelvedTheFilesInNumberedChangelists") : t("p4.shelved"));
        await reloadPending(current, numbered[0]?.change);
        return true;
      } catch (caught) {
        report(caught);
        return false;
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reloadPending, report],
  );

  const shelveSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.shelving"));
    if (!release) return;
    const id = beginActivity(t("p4.shelving"), current.selectedChange);
    try {
      await guard(current.connection, () => p4Api.shelve(current.connection, current.selectedChange));
      toast.success(t("p4.shelved"));
      await reloadPending(current, current.selectedChange);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const unshelveSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.unshelving"));
    if (!release) return;
    const id = beginActivity(t("p4.unshelving"), current.selectedChange);
    try {
      await guard(current.connection, () => p4Api.unshelve(current.connection, current.selectedChange));
      toast.success(t("p4.unshelved"));
      await reloadPending(current, current.selectedChange);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const deleteSelectedShelf = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.deletingShelf"));
    if (!release) return;
    const id = beginActivity(t("p4.deletingShelf"), current.selectedChange);
    try {
      await guard(current.connection, () => p4Api.deleteShelf(current.connection, current.selectedChange));
      toast.success(t("p4.shelfDeleted"));
      await reloadPending(current, current.selectedChange);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const resolveView = useCallback(
    async (path: string) => {
      const current = sessionRef.current;
      if (!current) return null;
      return guard(current.connection, () => p4Api.resolveView(current.connection, path));
    },
    [guard],
  );

  const resolveAccept = useCallback(
    async (path: string, mode: "yours" | "theirs" | "merge") => {
      const current = sessionRef.current;
      if (!current) return false;
      const label = mode === "yours" ? t("p4.acceptingYours") : mode === "theirs" ? t("p4.acceptingTheirs") : t("p4.merging");
      const release = lockMutation(current, label);
      if (!release) return false;
      const id = beginActivity(label, depotBase(path));
      try {
        await guard(current.connection, () => p4Api.resolveAccept(current.connection, path, mode));
        toast.success(mode === "merge" ? t("p4.merged") : mode === "yours" ? t("p4.acceptedYours") : t("p4.acceptedTheirs"));
        await reloadPending(current, current.selectedChange);
        return true;
      } catch (caught) {
        report(caught);
        return false;
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reloadPending, report],
  );

  const revertUnchanged = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.revertingUnchanged"));
    if (!release) return;
    const id = beginActivity(t("p4.revertingUnchanged"));
    try {
      await guard(current.connection, () => p4Api.revertUnchanged(current.connection));
      await reloadPending(current);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, endActivity, guard, reloadPending, report]);

  const sync = useCallback(
    async (paths: string[] = []) => {
      const current = sessionRef.current;
      if (!current) return;
      const release = lockMutation(current, t("p4.gettingLatest"));
      if (!release) return;
      const id = beginActivity(t("p4.gettingLatest"), current.connection.client);
      try {
        const output = await guard(current.connection, () => p4Api.sync(current.connection, paths, id));
        toast.success(syncSummary(output));
        await reloadPending(current);
        bumpFiles();
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, bumpFiles, endActivity, guard, reloadPending, report],
  );

  const getRevision = useCallback(
    async (request: P4GetRevision) => {
      const current = sessionRef.current;
      if (!current) return "";
      const release = lockMutation(current, request.preview ? t("p4.previewingRevision") : t("p4.gettingRevision"));
      if (!release) return "";
      const id = beginActivity(request.preview ? t("p4.previewingRevision") : t("p4.gettingRevision"));
      try {
        const output = await guard(current.connection, () =>
          p4Api.getRevision(current.connection, request, id),
        );
        if (!request.preview) {
          toast.success(lastLine(output) || t("p4.gotRevision"));
          await reloadPending(current);
          bumpFiles();
        }
        return output;
      } catch (caught) {
        report(caught);
        throw caught;
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, bumpFiles, endActivity, guard, reloadPending, report],
  );

  const reconcile = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const release = lockMutation(current, t("p4.reconciling"));
    if (!release) return;
    const id = beginActivity(t("p4.reconciling"), current.connection.client);
    try {
      const output = await guard(current.connection, () => p4Api.reconcile(current.connection, id));
      toast.success(lastLine(output) || t("p4.reconciled"));
      await reloadPending(current, "default");
      bumpFiles();
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
      release();
    }
  }, [lockMutation, beginActivity, bumpFiles, endActivity, guard, reloadPending, report]);

  const fileAction = useCallback(
    async (action: "edit" | "add" | "delete", paths: string[]) => {
      const current = sessionRef.current;
      if (!current || paths.length === 0) return;
      const label = action === "edit" ? t("p4.openingForEdit") : action === "add" ? t("p4.markingForAdd") : t("p4.markingForDelete");
      const release = lockMutation(current, label);
      if (!release) return;
      const id = beginActivity(label);
      try {
        await guard(current.connection, () => p4Api.fileAction(current.connection, action, paths));
        await reloadPending(current, "default");
        bumpFiles();
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, bumpFiles, endActivity, guard, reloadPending, report],
  );

  const loadSubmitted = useCallback(
    async (more = false) => {
      const current = sessionRef.current;
      if (!current) return;
      const key = `${current.tabId}:list`;
      const token = nextToken(submittedTokens.current, key);
      setSubmittedBusy((busy) => new Set(busy).add(key));
      try {
        const oldest = more ? oldestChange(current.submitted) : null;
        const page = await guard(current.connection, () =>
          p4Api.submitted(
            current.connection,
            current.submittedUser,
            current.submittedClient,
            50,
            oldest,
          ),
        );
        if (submittedTokens.current.get(key) !== token) return;
        const latest = cache.current.get(current.tabId);
        if (
          !latest ||
          !sameP4Connection(latest.connection, current.connection) ||
          latest.submittedUser !== current.submittedUser ||
          latest.submittedClient !== current.submittedClient
        ) {
          return;
        }
        const submitted = more ? mergeChanges(latest.submitted, page.changes) : page.changes;
        updateSession(current.tabId, (value) => ({ ...value, submitted, submittedHasMore: page.hasMore }));
      } catch (caught) {
        report(caught);
      } finally {
        if (submittedTokens.current.get(key) === token) {
          setSubmittedBusy((busy) => withoutKey(busy, key));
        }
      }
    },
    [guard, report, updateSession],
  );

  const setSubmittedFilter = useCallback(
    (user: string, client: string) => {
      const current = sessionRef.current;
      if (!current || (current.submittedUser === user && current.submittedClient === client)) return;
      patch({
        submittedUser: user,
        submittedClient: client,
        submitted: [],
        submittedHasMore: true,
        selectedSubmitted: null,
        submittedDetail: null,
        submittedDiffs: [],
      });
      void loadSubmitted(false);
    },
    [loadSubmitted, patch],
  );

  const listUsers = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return [];
    return guard(current.connection, () => p4Api.listUsers(current.connection));
  }, [guard]);

  const listClients = useCallback(async (user: string) => {
    const current = sessionRef.current;
    if (!current || !user.trim()) return [];
    return guard(current.connection, () => p4Api.listClients(current.connection, user));
  }, [guard]);

  const listStreams = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return [];
    return guard(current.connection, () =>
      p4Api.listStreams({
        port: current.connection.port,
        user: current.connection.user,
        password: "",
        charset: current.connection.charset,
      }),
    );
  }, [guard]);

  const selectSubmitted = useCallback(
    async (id: string) => {
      const current = sessionRef.current;
      if (!current) return;
      if (current.selectedSubmitted === id && current.submittedDetail?.id === id) return;
      patch({ selectedSubmitted: id, submittedDetail: null, submittedDiffs: [] });
      const key = `${current.tabId}:detail`;
      const token = nextToken(submittedTokens.current, key);
      setSubmittedBusy((busy) => new Set(busy).add(key));
      try {
        const described = await guard(current.connection, () => p4Api.describe(current.connection, id));
        if (submittedTokens.current.get(key) !== token) return;
        const latest = cache.current.get(current.tabId);
        if (!latest || !sameP4Connection(latest.connection, current.connection) || latest.selectedSubmitted !== id) return;
        updateSession(current.tabId, (value) => ({ ...value,
          selectedSubmitted: id,
          submittedDetail: described.change,
          submittedDiffs: [],
        }));
      } catch (caught) {
        if (submittedTokens.current.get(key) !== token) return;
        const latest = cache.current.get(current.tabId);
        if (!latest || !sameP4Connection(latest.connection, current.connection) || latest.selectedSubmitted !== id) return;
        report(caught);
      } finally {
        if (submittedTokens.current.get(key) === token) {
          setSubmittedBusy((busy) => withoutKey(busy, key));
        }
      }
    },
    [guard, patch, report, updateSession],
  );

  const listDir = useCallback(
    async (relative: string) => {
      const current = sessionRef.current;
      if (!current) return [];
      return guard(current.connection, () => p4Api.listDir(current.connection, relative));
    },
    [guard],
  );

  const listDepot = useCallback(
    async (path: string) => {
      const current = sessionRef.current;
      if (!current) return [];
      return guard(current.connection, () => p4Api.listDepot(current.connection, path));
    },
    [guard],
  );

  const searchDepot = useCallback(
    async (query: string) => {
      const current = sessionRef.current;
      if (!current) return null;
      return guard(current.connection, () => p4Api.searchDepot(current.connection, query));
    },
    [guard],
  );

  const filelog = useCallback(
    async (path: string) => {
      const current = sessionRef.current;
      if (!current) return [];
      return guard(current.connection, () => p4Api.filelog(current.connection, path));
    },
    [guard],
  );

  const revisionDiff = useCallback(
    async (depotPath: string, rev: string) => {
      const current = sessionRef.current;
      if (!current) return null;
      return guard(current.connection, () => p4Api.revisionDiff(current.connection, depotPath, rev));
    },
    [guard],
  );

  const searchSubmitted = useCallback(
    async (query: string, before: number | null, matchLimit: number, scanLimit: number) => {
      const current = sessionRef.current;
      if (!current) return null;
      try {
        return await guard(current.connection, () =>
          p4Api.searchSubmitted(
            current.connection,
            current.submittedUser,
            current.submittedClient,
            query,
            before,
            matchLimit,
            scanLimit,
          ),
        );
      } catch (caught) {
        report(caught);
        return null;
      }
    },
    [guard, report],
  );

  const saveWorkspace = useCallback(
    async (root: string, stream: string) => {
      const current = sessionRef.current;
      const tab = activeTabRef.current;
      if (!current || tab.kind !== "repo") return;
      const release = lockMutation(current, t("p4.savingWorkspace"));
      if (!release) return;
      const id = beginActivity(t("p4.savingWorkspace"), current.connection.client);
      try {
        const next = await guard(current.connection, () => p4Api.saveWorkspace(current.connection, root, stream));
        if (!sameRepoPath(current.connection.root, next.root)) {
          cache.current.delete(current.tabId);
          retargetRepoTab(tab.id, next.root, next.client);
        } else {
          setTabMeta(tab.id, next.client);
          invalidateP4Session(cache.current, current.tabId, activeTabRef.current.id, reconnect);
        }
      } catch (caught) {
        report(caught);
        throw caught;
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, guard, reconnect, report, retargetRepoTab, setTabMeta],
  );

  const saveConnection = useCallback(
    async (edit: P4Auth & { client: string }) => {
      const current = sessionRef.current;
      const tab = activeTabRef.current;
      if (!current || tab.kind !== "repo") return;
      const release = lockMutation(current, t("p4.savingConnection"));
      if (!release) return;
      const id = beginActivity(t("p4.savingConnection"), edit.client);
      try {
        const root = await p4Api.prepareClient(edit, edit.client);
        if (!sameRepoPath(current.connection.root, root)) {
          cache.current.delete(current.tabId);
          retargetRepoTab(tab.id, root, edit.client);
        } else {
          setTabMeta(tab.id, edit.client);
          invalidateP4Session(cache.current, current.tabId, activeTabRef.current.id, reconnect);
        }
      } catch (caught) {
        report(caught);
        throw caught;
      } finally {
        endActivity(id);
        release();
      }
    },
    [lockMutation, beginActivity, endActivity, reconnect, report, retargetRepoTab, setTabMeta],
  );

  const value = useMemo<P4ContextValue>(
    () => ({
      view: visibleSession?.view ?? "pending",
      setView,
      connection,
      pending: visibleSession?.pending ?? [],
      loading,
      busy: mutationLabels.has(activePerforceId),
      busyLabel: mutationLabels.get(activePerforceId)?.label ?? "",
      busyKind: mutationLabels.get(activePerforceId)?.kind ?? null,
      error: error === P4_MISSING ? t("desktop.dependencies.p4Missing", { lng: language }) : error ? p4DisplayError(error, language) : null,
      selectedChange,
      selectedFile,
      selectedShelved,
      description: visibleSession?.description ?? "",
      setDescription,
      diff: visibleSession?.diff ?? null,
      diffLoading,
      submitted: visibleSession?.submitted ?? [],
      submittedLoading,
      submittedHasMore: visibleSession?.submittedHasMore ?? true,
      selectedSubmitted: visibleSession?.selectedSubmitted ?? null,
      submittedDetail: visibleSession?.submittedDetail ?? null,
      submittedDiffs: visibleSession?.submittedDiffs ?? [],
      refresh,
      selectChange,
      selectFile,
      submitSelected,
      saveSelected,
      createChange,
      deleteChange,
      renameFile,
      previewIntegrate,
      applyIntegrate,
      previewUndo,
      applyUndo,
      resolveRequest: visibleSession?.resolveRequest ?? null,
      dismissResolveRequest,
      lockFiles,
      moveFiles,
      placeFiles,
      revertPaths,
      shelveFiles,
      shelveSelected,
      unshelveSelected,
      deleteSelectedShelf,
      resolveView,
      resolveAccept,
      revertUnchanged,
      sync,
      getRevision,
      filesEpoch,
      reconcile,
      fileAction,
      loadSubmitted,
      submittedUser: visibleSession?.submittedUser ?? connection?.user ?? "",
      submittedClient: visibleSession?.submittedClient ?? connection?.client ?? "",
      setSubmittedFilter,
      listUsers,
      listClients,
      listStreams,
      selectSubmitted,
      listDir,
      listDepot,
      searchDepot,
      filelog,
      revisionDiff,
      searchSubmitted,
      reconnect,
      connectionOpen,
      setConnectionOpen,
      saveConnection,
      workspaceOpen,
      setWorkspaceOpen,
      saveWorkspace,
    }),
    [
      activePerforceId,
      language,
      mutationLabels,
      connection,
      createChange,
      deleteChange,
      renameFile,
      previewIntegrate,
      applyIntegrate,
      previewUndo,
      applyUndo,
      dismissResolveRequest,
      lockFiles,
      deleteSelectedShelf,
      resolveAccept,
      resolveView,
      diffLoading,
      error,
      fileAction,
      filesEpoch,
      filelog,
      getRevision,
      listClients,
      listDir,
      listDepot,
      searchDepot,
      listStreams,
      listUsers,
      loadSubmitted,
      loading,
      moveFiles,
      placeFiles,
      reconcile,
      reconnect,
      refresh,
      connectionOpen,
      saveConnection,
      saveWorkspace,
      searchSubmitted,
      workspaceOpen,
      revertPaths,
      shelveFiles,
      revertUnchanged,
      revisionDiff,
      saveSelected,
      selectChange,
      selectFile,
      selectSubmitted,
      selectedChange,
      selectedFile,
      selectedShelved,
      visibleSession,
      setDescription,
      setSubmittedFilter,
      setView,
      shelveSelected,
      submitSelected,
      submittedLoading,
      sync,
      unshelveSelected,
    ],
  );

  return (
    <P4Context.Provider value={value}>
      {children}
      <P4ConnectionDialog />
      <P4WorkspaceDialog />
      <P4LoginDialog
        open={loginOpen}
        client={loginTarget.client}
        port={loginTarget.port}
        onCancel={() => finishLogin(null)}
        onSubmit={(password) => finishLogin(password)}
      />
    </P4Context.Provider>
  );
}

export function useP4() {
  const value = useContext(P4Context);
  if (!value) throw new Error("useP4 must be used within P4Provider");
  return value;
}

function groupPaths(files: { change: string; path: string }[]) {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const paths = groups.get(file.change) ?? [];
    paths.push(file.path);
    groups.set(file.change, paths);
  }
  return groups;
}

function oldestChange(changes: P4Changelist[]) {
  const numbers = changes.map((change) => Number(change.id)).filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length === 0) return null;
  return Math.min(...numbers);
}

function mergeChanges(current: P4Changelist[], next: P4Changelist[]) {
  const seen = new Set(current.map((change) => change.id));
  return [...current, ...next.filter((change) => !seen.has(change.id))];
}

function lastLine(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1];
  if (!line) return "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function nextToken(tokens: Map<string, number>, key: string) {
  const next = (tokens.get(key) ?? 0) + 1;
  tokens.set(key, next);
  return next;
}

function withoutKey(values: ReadonlySet<string>, key: string) {
  const next = new Set(values);
  next.delete(key);
  return next;
}
