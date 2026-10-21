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
import type { FileDiff } from "@/types/git";
import type {
  P4Auth,
  P4ChangePage,
  P4Changelist,
  P4Connection,
  P4DirEntry,
  P4File,
  P4FileSearch,
  P4GetRevision,
  P4ResolveView,
  P4Revision,
  P4StreamOption,
} from "@/types/p4";

export type P4View = "pending" | "submitted" | "workspace";

const OPEN_SETTINGS_EVENT = "rebasely-open-settings";

class LoginCancelled extends Error {
  constructor() {
    super("Login cancelled");
  }
}

interface Session {
  tabId: string;
  connection: P4Connection;
  pending: P4Changelist[];
  selectedChange: string;
  selectedFile: string | null;
  selectedShelved: boolean;
  description: string;
  diff: FileDiff | null;
  diffFor: string;
  submitted: P4Changelist[];
  submittedHasMore: boolean;
  selectedSubmitted: string | null;
  submittedDetail: P4Changelist | null;
  submittedDiffs: FileDiff[];
  submittedUser: string;
  submittedClient: string;
  view: P4View;
}

interface P4ContextValue {
  view: P4View;
  setView: (view: P4View) => void;
  connection: P4Connection | null;
  pending: P4Changelist[];
  loading: boolean;
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
  createChange: (description: string) => Promise<void>;
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
  const [submittedLoading, setSubmittedLoading] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [filesEpoch, setFilesEpoch] = useState(0);
  const bumpFiles = useCallback(() => setFilesEpoch((value) => value + 1), []);
  const cache = useRef(new Map<string, Session>());
  const generation = useRef(0);
  const diffToken = useRef(0);
  const refreshing = useRef(false);
  const sessionRef = useRef(session);
  const loginRef = useRef<{ resolve: (value: string | null) => void } | null>(null);
  const activeTabRef = useRef(activeTab);
  const activePerforceId = activeTab.kind === "repo" && activeTab.vcs === "perforce" ? activeTab.id : "";
  const [attempt, setAttempt] = useState(0);
  const [loginTarget, setLoginTarget] = useState({ client: "", port: "" });
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);

  useLayoutEffect(() => {
    activeTabRef.current = activeTab;
    sessionRef.current = session;
  }, [activeTab, session]);

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
      try {
        return await fn();
      } catch (error) {
        if (errorMessage(error) !== P4_LOGIN) throw error;
        const password = await askPassword(connection);
        if (!password) throw new LoginCancelled();
        await p4Api.login(connection, password);
        return await fn();
      }
    },
    [askPassword],
  );

  const report = useCallback((caught: unknown) => {
    if (caught instanceof LoginCancelled) return;
    const message = errorMessage(caught);
    if (!message) return;
    if (message === P4_MISSING) {
      toast.error(message, {
        id: "p4-missing",
        action: {
          label: "Settings",
          onClick: () => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT)),
        },
      });
      return;
    }
    toast.error(message);
  }, []);

  const remember = useCallback((next: Session) => {
    cache.current.set(next.tabId, next);
    sessionRef.current = next;
    setSession(next);
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
    const token = ++diffToken.current;
    const load = current.selectedShelved
      ? p4Api.shelfDiff(current.connection, file, current.selectedChange)
      : p4Api.openedDiff(current.connection, file);
    void guard(current.connection, () => load)
      .then((diff) => {
        if (token !== diffToken.current) return;
        const latest = sessionRef.current;
        if (!latest || fileKey(latest.selectedChange, latest.selectedFile, latest.selectedShelved) !== key) return;
        patch({ diff, diffFor: key });
      })
      .catch((caught) => {
        if (token !== diffToken.current) return;
        const latest = sessionRef.current;
        if (!latest || fileKey(latest.selectedChange, latest.selectedFile, latest.selectedShelved) !== key) return;
        patch({ diff: null, diffFor: key });
        report(caught);
      });
  }, [guard, patch, report]);

  useEffect(() => {
    if (!activePerforceId) return;
    const tab = activeTabRef.current;
    if (tab.kind !== "repo" || tab.vcs !== "perforce") return;
    const token = ++generation.current;
    const cached = cache.current.get(tab.id);
    if (cached) {
      sessionRef.current = cached;
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
          if (opened.status !== "ready") throw new Error("Perforce rejected that password.");
        }
        if (opened.status !== "ready") return;
        const name = opened.connection.client || target.name;
        const tabId = repoTabId(opened.connection.root, "perforce");
        if (!sameRepoPath(target.path, opened.connection.root)) {
          retargetRepoTab(target.id, opened.connection.root, name);
        } else {
          setTabMeta(target.id, name);
        }
        const previous = cache.current.get(tabId);
        const pending = opened.pending;
        const selectedChange =
          previous && pending.some((change) => change.id === previous.selectedChange)
            ? previous.selectedChange
            : defaultChange(pending);
        const selected = pending.find((change) => change.id === selectedChange);
        const shown = shownFile(selected?.files ?? []);
        const next: Session = {
          tabId,
          connection: opened.connection,
          pending,
          selectedChange,
          selectedFile: shown.path,
          selectedShelved: shown.shelved,
          description: selected?.description ?? "",
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
        };
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
  }, [activePerforceId, attempt, askPassword, refreshRecents, remember, report, requestDiff, retargetRepoTab, setTabMeta]);

  const connection = session?.connection ?? null;
  const selectedFile = session?.selectedFile ?? null;
  const selectedShelved = session?.selectedShelved ?? false;
  const selectedChange = session?.selectedChange ?? "default";
  const diffKey = connection && selectedFile ? fileKey(selectedChange, selectedFile, selectedShelved) : "";
  const diffLoading = diffKey !== "" && session?.diffFor !== diffKey;

  const refresh = useCallback(async (quiet = false) => {
    const current = sessionRef.current;
    if (!current || refreshing.current) return;
    refreshing.current = true;
    const id = beginActivity("Refreshing workspace", current.connection.client);
    try {
      const pending = await guard(current.connection, () => p4Api.refreshPending(current.connection));
      const selected = pending.some((change) => change.id === current.selectedChange)
        ? current.selectedChange
        : defaultChange(pending);
      const change = pending.find((item) => item.id === selected);
      const shown = shownFile(change?.files ?? [], {
        path: current.selectedFile,
        shelved: current.selectedShelved,
      });
      const sameFile = shown.path === current.selectedFile && shown.shelved === current.selectedShelved && selected === current.selectedChange;
      patch({
        pending,
        selectedChange: selected,
        selectedFile: shown.path,
        selectedShelved: shown.shelved,
        description: change?.description ?? "",
        diff: sameFile ? current.diff : null,
        diffFor: sameFile ? current.diffFor : "",
      });
      const latest = sessionRef.current;
      if (latest) requestDiff(latest);
    } catch (caught) {
      if (!quiet) report(caught);
    } finally {
      refreshing.current = false;
      endActivity(id);
    }
  }, [beginActivity, endActivity, guard, patch, report, requestDiff]);

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

  const reloadPending = useCallback(
    async (selectId?: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const pending = await guard(current.connection, () => p4Api.refreshPending(current.connection));
      const selected = selectId && pending.some((change) => change.id === selectId)
        ? selectId
        : pending.some((change) => change.id === current.selectedChange)
          ? current.selectedChange
          : defaultChange(pending);
      const change = pending.find((item) => item.id === selected);
      const shown = shownFile(change?.files ?? [], {
        path: current.selectedFile,
        shelved: current.selectedShelved,
      });
      const sameSelection =
        selected === current.selectedChange &&
        shown.path === current.selectedFile &&
        shown.shelved === current.selectedShelved;
      patch({
        pending,
        selectedChange: selected,
        selectedFile: shown.path,
        selectedShelved: shown.shelved,
        description: change?.description ?? current.description,
        diff: sameSelection ? current.diff : null,
        diffFor: sameSelection ? current.diffFor : "",
      });
      const latest = sessionRef.current;
      if (latest) requestDiff(latest);
    },
    [guard, patch, requestDiff],
  );

  const submitSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = beginActivity("Submitting", current.selectedChange);
    try {
      await guard(current.connection, () =>
        p4Api.submit(current.connection, current.selectedChange, current.description),
      );
      toast.success("Submitted");
      await reloadPending("default");
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
    }
  }, [beginActivity, endActivity, guard, reloadPending, report]);

  const saveSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = beginActivity("Saving changelist", current.selectedChange);
    try {
      const saved = await guard(current.connection, () =>
        p4Api.saveChange(current.connection, current.selectedChange, current.description),
      );
      toast.success(current.selectedChange === "default" ? `Created change ${saved}` : "Description saved");
      await reloadPending(saved);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
    }
  }, [beginActivity, endActivity, guard, reloadPending, report]);

  const createChange = useCallback(
    async (description: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const id = beginActivity("Creating changelist");
      try {
        const saved = await guard(current.connection, () => p4Api.newChange(current.connection, description));
        toast.success(`Created change ${saved}`);
        await reloadPending(saved);
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, guard, reloadPending, report],
  );

  const moveFiles = useCallback(
    async (depotPaths: string[], changeId: string) => {
      const current = sessionRef.current;
      if (!current || depotPaths.length === 0) return;
      try {
        await guard(current.connection, () => p4Api.reopen(current.connection, changeId, depotPaths));
        await reloadPending(changeId);
      } catch (caught) {
        report(caught);
      }
    },
    [guard, reloadPending, report],
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
      const label = !shelved && !shelf ? "Moving" : shelved && !shelf ? "Unshelving" : "Shelving";
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
        toast.success(!shelved && !shelf ? "Moved" : shelved && !shelf ? "Unshelved" : "Shelved");
        await reloadPending(targetChange);
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, guard, reloadPending, report],
  );

  const revertPaths = useCallback(
    async (paths: string[], wipe: string[] = []) => {
      const current = sessionRef.current;
      if (!current || (paths.length === 0 && wipe.length === 0)) return;
      const id = beginActivity("Reverting");
      try {
        await guard(current.connection, () => p4Api.revert(current.connection, paths, wipe));
        toast.success("Reverted");
        await reloadPending();
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, guard, reloadPending, report],
  );

  const shelveFiles = useCallback(
    async (files: { change: string; path: string }[]) => {
      const current = sessionRef.current;
      const numbered = files.filter((file) => file.change !== "default");
      if (!current || numbered.length === 0) return false;
      const id = beginActivity("Shelving");
      try {
        await guard(current.connection, async () => {
          for (const [change, paths] of groupPaths(numbered)) {
            await p4Api.shelve(current.connection, change, paths);
          }
        });
        const skipped = files.length - numbered.length;
        toast.success(skipped > 0 ? "Shelved the files in numbered changelists." : "Shelved");
        await reloadPending(numbered[0]?.change);
        return true;
      } catch (caught) {
        report(caught);
        return false;
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, guard, reloadPending, report],
  );

  const shelveSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = beginActivity("Shelving", current.selectedChange);
    try {
      await guard(current.connection, () => p4Api.shelve(current.connection, current.selectedChange));
      toast.success("Shelved");
      await reloadPending(current.selectedChange);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
    }
  }, [beginActivity, endActivity, guard, reloadPending, report]);

  const unshelveSelected = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = beginActivity("Unshelving", current.selectedChange);
    try {
      await guard(current.connection, () => p4Api.unshelve(current.connection, current.selectedChange));
      toast.success("Unshelved");
      await reloadPending(current.selectedChange);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
    }
  }, [beginActivity, endActivity, guard, reloadPending, report]);

  const deleteSelectedShelf = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = beginActivity("Deleting shelf", current.selectedChange);
    try {
      await guard(current.connection, () => p4Api.deleteShelf(current.connection, current.selectedChange));
      toast.success("Shelf deleted");
      await reloadPending(current.selectedChange);
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
    }
  }, [beginActivity, endActivity, guard, reloadPending, report]);

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
      const label = mode === "yours" ? "Accepting yours" : mode === "theirs" ? "Accepting theirs" : "Merging";
      const id = beginActivity(label, depotBase(path));
      try {
        await guard(current.connection, () => p4Api.resolveAccept(current.connection, path, mode));
        toast.success(mode === "merge" ? "Merged" : mode === "yours" ? "Accepted yours" : "Accepted theirs");
        await reloadPending(current.selectedChange);
        return true;
      } catch (caught) {
        report(caught);
        return false;
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, guard, reloadPending, report],
  );

  const revertUnchanged = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      await guard(current.connection, () => p4Api.revertUnchanged(current.connection));
      await reloadPending();
    } catch (caught) {
      report(caught);
    }
  }, [guard, reloadPending, report]);

  const sync = useCallback(
    async (paths: string[] = []) => {
      const current = sessionRef.current;
      if (!current) return;
      const id = beginActivity("Getting latest", current.connection.client);
      try {
        const output = await guard(current.connection, () => p4Api.sync(current.connection, paths, id));
        toast.success(syncSummary(output));
        await reloadPending();
        bumpFiles();
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, bumpFiles, endActivity, guard, reloadPending, report],
  );

  const getRevision = useCallback(
    async (request: P4GetRevision) => {
      const current = sessionRef.current;
      if (!current) return "";
      const id = beginActivity(request.preview ? "Previewing revision" : "Getting revision");
      try {
        const output = await guard(current.connection, () =>
          p4Api.getRevision(current.connection, request, id),
        );
        if (!request.preview) {
          toast.success(lastLine(output) || "Got revision");
          await reloadPending();
          bumpFiles();
        }
        return output;
      } catch (caught) {
        report(caught);
        throw caught;
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, bumpFiles, endActivity, guard, reloadPending, report],
  );

  const reconcile = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const id = beginActivity("Reconciling", current.connection.client);
    try {
      const output = await guard(current.connection, () => p4Api.reconcile(current.connection, id));
      toast.success(lastLine(output) || "Reconciled");
      await reloadPending("default");
      bumpFiles();
    } catch (caught) {
      report(caught);
    } finally {
      endActivity(id);
    }
  }, [beginActivity, bumpFiles, endActivity, guard, reloadPending, report]);

  const fileAction = useCallback(
    async (action: "edit" | "add" | "delete", paths: string[]) => {
      const current = sessionRef.current;
      if (!current || paths.length === 0) return;
      const label = action === "edit" ? "Opening for edit" : action === "add" ? "Marking for add" : "Marking for delete";
      const id = beginActivity(label);
      try {
        await guard(current.connection, () => p4Api.fileAction(current.connection, action, paths));
        await reloadPending("default");
        bumpFiles();
      } catch (caught) {
        report(caught);
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, bumpFiles, endActivity, guard, reloadPending, report],
  );

  const loadSubmitted = useCallback(
    async (more = false) => {
      const current = sessionRef.current;
      if (!current) return;
      setSubmittedLoading(true);
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
        const latest = sessionRef.current;
        if (
          !latest ||
          latest.submittedUser !== current.submittedUser ||
          latest.submittedClient !== current.submittedClient
        ) {
          return;
        }
        const submitted = more ? mergeChanges(latest.submitted, page.changes) : page.changes;
        patch({ submitted, submittedHasMore: page.hasMore });
      } catch (caught) {
        report(caught);
      } finally {
        setSubmittedLoading(false);
      }
    },
    [guard, patch, report],
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
      setSubmittedLoading(true);
      try {
        const described = await guard(current.connection, () => p4Api.describe(current.connection, id));
        const latest = sessionRef.current;
        if (!latest || latest.selectedSubmitted !== id) return;
        patch({
          selectedSubmitted: id,
          submittedDetail: described.change,
          submittedDiffs: [],
        });
      } catch (caught) {
        const latest = sessionRef.current;
        if (!latest || latest.selectedSubmitted !== id) return;
        report(caught);
      } finally {
        if (sessionRef.current?.selectedSubmitted === id) setSubmittedLoading(false);
      }
    },
    [guard, patch, report],
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
      const id = beginActivity("Saving workspace", current.connection.client);
      try {
        const next = await guard(current.connection, () => p4Api.saveWorkspace(current.connection, root, stream));
        if (!sameRepoPath(current.connection.root, next.root)) {
          retargetRepoTab(tab.id, next.root, next.client);
        } else {
          setTabMeta(tab.id, next.client);
          reconnect();
        }
      } catch (caught) {
        report(caught);
        throw caught;
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, guard, reconnect, report, retargetRepoTab, setTabMeta],
  );

  const saveConnection = useCallback(
    async (edit: P4Auth & { client: string }) => {
      const current = sessionRef.current;
      const tab = activeTabRef.current;
      if (!current || tab.kind !== "repo") return;
      const id = beginActivity("Saving connection", edit.client);
      try {
        const root = await p4Api.prepareClient(edit, edit.client);
        if (!sameRepoPath(current.connection.root, root)) {
          retargetRepoTab(tab.id, root, edit.client);
        } else {
          setTabMeta(tab.id, edit.client);
          reconnect();
        }
      } catch (caught) {
        report(caught);
        throw caught;
      } finally {
        endActivity(id);
      }
    },
    [beginActivity, endActivity, reconnect, report, retargetRepoTab, setTabMeta],
  );

  const value = useMemo<P4ContextValue>(
    () => ({
      view: session?.view ?? "pending",
      setView,
      connection,
      pending: session?.pending ?? [],
      loading,
      error,
      selectedChange,
      selectedFile,
      selectedShelved,
      description: session?.description ?? "",
      setDescription,
      diff: session?.diff ?? null,
      diffLoading,
      submitted: session?.submitted ?? [],
      submittedLoading,
      submittedHasMore: session?.submittedHasMore ?? true,
      selectedSubmitted: session?.selectedSubmitted ?? null,
      submittedDetail: session?.submittedDetail ?? null,
      submittedDiffs: session?.submittedDiffs ?? [],
      refresh,
      selectChange,
      selectFile,
      submitSelected,
      saveSelected,
      createChange,
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
      submittedUser: session?.submittedUser ?? connection?.user ?? "",
      submittedClient: session?.submittedClient ?? connection?.client ?? "",
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
      connection,
      createChange,
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
      session,
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

function fileKey(change: string, file: string | null, shelved: boolean) {
  return `${change}\n${file ?? ""}\n${shelved ? "shelf" : "open"}`;
}

function shownFile(files: P4File[], preferred?: { path: string | null; shelved: boolean }) {
  if (
    preferred?.path &&
    files.some((file) => file.depotPath === preferred.path && file.shelved === preferred.shelved)
  ) {
    return { path: preferred.path, shelved: preferred.shelved };
  }
  const opened = files.find((file) => !file.shelved);
  if (opened) return { path: opened.depotPath, shelved: false };
  const shelf = files.find((file) => file.shelved);
  if (shelf) return { path: shelf.depotPath, shelved: true };
  return { path: null, shelved: false };
}

function defaultChange(pending: P4Changelist[]) {
  return pending.find((change) => change.id === "default")?.id ?? pending[0]?.id ?? "default";
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
