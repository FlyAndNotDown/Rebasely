import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { errorMessage, gitApi } from "@/lib/git";
import type {
  CommitDetails,
  CommitSummary,
  FileDiff,
  RecentRepo,
  Selection,
  WorkspaceSnapshot,
} from "@/types/git";

type View = "changes" | "history";

interface GitContextValue {
  recents: RecentRepo[];
  snapshot: WorkspaceSnapshot | null;
  commits: CommitSummary[];
  view: View;
  selection: Selection | null;
  diff: FileDiff | null;
  commitDetails: CommitDetails | null;
  loading: boolean;
  busy: boolean;
  setView: (view: View) => void;
  openFolder: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  forgetRecent: (path: string) => Promise<void>;
  closeRepo: () => Promise<void>;
  refresh: () => Promise<void>;
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
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [view, setView] = useState<View>("changes");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [commitDetails, setCommitDetails] = useState<CommitDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadRecents = useCallback(async () => {
    try {
      setRecents(await gitApi.listRecents());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecents();
  }, [loadRecents]);

  const applySnapshot = useCallback((next: WorkspaceSnapshot) => {
    setSnapshot(next);
  }, []);

  const refreshCommits = useCallback(async () => {
    try {
      setCommits(await gitApi.getCommits(120));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        const next = await gitApi.openRepository(path);
        applySnapshot(next);
        setSelection(null);
        setDiff(null);
        setCommitDetails(null);
        setView("changes");
        setRecents(await gitApi.listRecents());
        await refreshCommits();
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [applySnapshot, refreshCommits],
  );

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

  const closeRepo = useCallback(async () => {
    await gitApi.closeRepository();
    setSnapshot(null);
    setCommits([]);
    setSelection(null);
    setDiff(null);
    setCommitDetails(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      applySnapshot(await gitApi.refreshWorkspace());
      await refreshCommits();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [applySnapshot, refreshCommits, snapshot]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openFolder();
      }
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        void refresh();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFolder, refresh]);

  const selectChange = useCallback(async (path: string, staged: boolean) => {
    setView("changes");
    setSelection({ type: "change", path, staged });
    setCommitDetails(null);
    try {
      setDiff(await gitApi.getWorkdirDiff(path, staged));
    } catch (error) {
      setDiff(null);
      toast.error(errorMessage(error));
    }
  }, []);

  const selectCommit = useCallback(async (id: string) => {
    setView("history");
    setSelection({ type: "commit", id });
    try {
      const details = await gitApi.getCommitDetails(id);
      setCommitDetails(details);
      const first = details.files[0];
      if (first) {
        setSelection({ type: "commit", id, path: first.path });
        setDiff(await gitApi.getCommitDiff(id, first.path));
      } else {
        setDiff(null);
      }
    } catch (error) {
      setCommitDetails(null);
      setDiff(null);
      toast.error(errorMessage(error));
    }
  }, []);

  const selectCommitFile = useCallback(async (id: string, path: string) => {
    setView("history");
    setSelection({ type: "commit", id, path });
    try {
      if (!commitDetails || commitDetails.commit.id !== id) {
        setCommitDetails(await gitApi.getCommitDetails(id));
      }
      setDiff(await gitApi.getCommitDiff(id, path));
    } catch (error) {
      setDiff(null);
      toast.error(errorMessage(error));
    }
  }, [commitDetails]);

  const runMutation = useCallback(
    async (action: () => Promise<WorkspaceSnapshot>, success?: string) => {
      setBusy(true);
      try {
        applySnapshot(await action());
        if (success) toast.success(success);
        if (selection?.type === "change") {
          try {
            setDiff(await gitApi.getWorkdirDiff(selection.path, selection.staged));
          } catch {
            setDiff(null);
            setSelection(null);
          }
        }
        await refreshCommits();
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [applySnapshot, refreshCommits, selection],
  );

  const stage = useCallback(
    async (paths: string[]) => {
      await runMutation(() => gitApi.stagePaths(paths));
    },
    [runMutation],
  );

  const unstage = useCallback(
    async (paths: string[]) => {
      await runMutation(() => gitApi.unstagePaths(paths));
    },
    [runMutation],
  );

  const discard = useCallback(
    async (paths: string[]) => {
      await runMutation(() => gitApi.discardPaths(paths), "Discarded changes");
      if (selection?.type === "change" && paths.includes(selection.path)) {
        setSelection(null);
        setDiff(null);
      }
    },
    [runMutation, selection],
  );

  const commit = useCallback(
    async (message: string) => {
      await runMutation(() => gitApi.commit(message), "Created commit");
      setSelection(null);
      setDiff(null);
    },
    [runMutation],
  );

  const checkoutBranch = useCallback(
    async (name: string) => {
      await runMutation(() => gitApi.checkoutBranch(name), `Checked out ${name}`);
      setSelection(null);
      setDiff(null);
    },
    [runMutation],
  );

  const createBranch = useCallback(
    async (name: string, switchTo: boolean) => {
      await runMutation(
        () => gitApi.createBranch(name, switchTo),
        switchTo ? `Created and checked out ${name}` : `Created ${name}`,
      );
    },
    [runMutation],
  );

  const value = useMemo<GitContextValue>(
    () => ({
      recents,
      snapshot,
      commits,
      view,
      selection,
      diff,
      commitDetails,
      loading,
      busy,
      setView,
      openFolder,
      openPath,
      forgetRecent,
      closeRepo,
      refresh,
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
      snapshot,
      commits,
      view,
      selection,
      diff,
      commitDetails,
      loading,
      busy,
      openFolder,
      openPath,
      forgetRecent,
      closeRepo,
      refresh,
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
