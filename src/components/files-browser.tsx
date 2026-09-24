import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { DiffLines } from "@/components/diff-viewer";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { textColumns } from "@/lib/diff-text";
import { formatAbsoluteTime } from "@/lib/format";
import { errorMessage, gitApi } from "@/lib/git";
import { dirsToReload, touchesFile } from "@/lib/repo-paths";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useGitPick, useGitSelect } from "@/state/git-context";
import { usePanelGroupLayout } from "@/state/use-panel-group-layout";
import { useRepoChanged } from "@/state/use-repo-changed";
import type { AvatarProvider, BlameHunk, CommitSummary, DirEntry, FileDiff } from "@/types/git";

const PAGE = 80;

export function FilesBrowser() {
  const shell = usePanelGroupLayout("files");
  const repoPath = useGitSelect((state) => state.snapshot?.repo.path ?? "");
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"browse" | "history">("browse");
  // A commit picked from blame, to select when the history opens.
  const [pin, setPin] = useState<string | null>(null);
  const entriesRef = useRef(entries);
  useLayoutEffect(() => {
    entriesRef.current = entries;
  });

  const loadDir = useCallback(
    async (dir: string, quiet = false) => {
      if (!repoPath) return;
      try {
        const items = await gitApi.listDirectory(repoPath, dir);
        setEntries((current) => ({ ...current, [dir]: items }));
      } catch (error) {
        if (!quiet) {
          toast.error(errorMessage(error));
          return;
        }
        // The folder was deleted while it was expanded.
        setEntries((current) => {
          const { [dir]: _gone, ...rest } = current;
          return rest;
        });
      }
    },
    [repoPath],
  );

  // The workspace remounts per repository, so the root is listed once here.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    void gitApi
      .listDirectory(repoPath, "")
      .then((items) => {
        if (!cancelled) setEntries((current) => ({ ...current, "": items }));
      })
      .catch((error) => toast.error(errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  useRepoChanged(repoPath, (changed) => {
    for (const dir of dirsToReload(repoPath, changed, Object.keys(entriesRef.current))) {
      void loadDir(dir, true);
    }
  });

  const openBlameCommit = useCallback((commitId: string) => {
    setPin(commitId);
    setMode("history");
  }, []);

  return (
    <ResizablePanelGroup
      id="files"
      orientation="horizontal"
      className="min-h-0 min-w-0 flex-1"
      groupRef={shell.groupRef}
      defaultLayout={shell.defaultLayout}
      onLayoutChanged={shell.onLayoutChanged}
    >
      <ResizablePanel id="files-tree" defaultSize="22%" minSize="14%" maxSize="40%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">Files</div>
          <ScrollArea className="min-h-0 flex-1">
            <DirRows
              dir=""
              depth={0}
              entries={entries}
              open={open}
              selected={path}
              onToggle={async (dir) => {
                if (open.has(dir)) {
                  setOpen((current) => {
                    const next = new Set(current);
                    next.delete(dir);
                    return next;
                  });
                  return;
                }
                if (!entries[dir]) await loadDir(dir);
                setOpen((current) => new Set(current).add(dir));
              }}
              onOpenFile={(next) => {
                setPath(next);
                setPin(null);
              }}
            />
          </ScrollArea>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="files-main" defaultSize="78%" minSize="40%">
        {!path ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            Select a file
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
              <div className="flex shrink-0 rounded-md bg-muted p-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "browse" ? "secondary" : "ghost"}
                  className="h-6 px-2 text-xs"
                  onClick={() => setMode("browse")}
                >
                  File
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "history" ? "secondary" : "ghost"}
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setPin(null);
                    setMode("history");
                  }}
                >
                  History
                </Button>
              </div>
            </div>
            {mode === "browse" ? (
              <FileBrowsePane key={path} repoPath={repoPath} path={path} onOpenCommit={openBlameCommit} />
            ) : (
              <FileHistoryPane key={`${path}\0${pin ?? ""}`} repoPath={repoPath} path={path} pin={pin} />
            )}
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/** One file's text and blame. Keyed by path, so it starts out loading. */
function FileBrowsePane({
  repoPath,
  path,
  onOpenCommit,
}: {
  repoPath: string;
  path: string;
  onOpenCommit: (commitId: string) => void;
}) {
  const { beginActivity, endActivity } = useGitPick(["beginActivity", "endActivity"]);
  const [fileText, setFileText] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [textLoading, setTextLoading] = useState(true);
  const [hunks, setHunks] = useState<BlameHunk[] | null>(null);
  const [blameLoading, setBlameLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const textActivity = beginActivity("Reading file", path);
    const blameActivity = beginActivity("Blaming file", path);
    void gitApi
      .readFile(repoPath, path)
      .then((result) => {
        if (cancelled) return;
        setBinary(result.binary);
        setFileText(result.text);
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error));
      })
      .finally(() => {
        endActivity(textActivity);
        if (!cancelled) setTextLoading(false);
      });
    void gitApi
      .fileBlame(repoPath, path)
      .then((result) => {
        if (!cancelled) setHunks(result);
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error));
      })
      .finally(() => {
        endActivity(blameActivity);
        if (!cancelled) setBlameLoading(false);
      });
    return () => {
      cancelled = true;
      endActivity(textActivity);
      endActivity(blameActivity);
    };
  }, [beginActivity, endActivity, path, repoPath]);

  // Edits and commits refresh the view in place, without the loading skeleton.
  useRepoChanged(repoPath, (changed) => {
    if (!touchesFile(repoPath, changed, path)) return;
    void Promise.all([gitApi.readFile(repoPath, path), gitApi.fileBlame(repoPath, path)])
      .then(([file, blame]) => {
        setBinary(file.binary);
        setFileText(file.text);
        setHunks(blame);
      })
      .catch(() => undefined);
  });

  return (
    <FileBrowse
      textLoading={textLoading}
      blameLoading={blameLoading}
      binary={binary}
      text={fileText}
      hunks={hunks}
      onOpenCommit={onOpenCommit}
    />
  );
}

/** One file's commit history and the selected commit's diff. Keyed by path and pin. */
function FileHistoryPane({ repoPath, path, pin }: { repoPath: string; path: string; pin: string | null }) {
  const layout = usePanelGroupLayout("fileHistory");
  const avatarProvider = useGitSelect((state) => state.prefs.avatarProvider);
  const { beginActivity, endActivity } = useGitPick(["beginActivity", "endActivity"]);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  // Commits read from the log so far; the pinned commit may be extra.
  const [fetched, setFetched] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(pin);
  const [loadedDiff, setLoadedDiff] = useState<{ key: string; diff: FileDiff } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const activity = beginActivity("Loading file history", path);
    void (async () => {
      try {
        const page = await gitApi.fileCommits(repoPath, path, PAGE, 0);
        let items = page;
        if (pin && !page.some((commit) => commit.id === pin)) {
          const details = await gitApi.getCommitDetails(repoPath, pin);
          items = [details.commit, ...page];
        }
        if (cancelled) return;
        setCommits(items);
        setFetched(page.length);
        setHasMore(page.length === PAGE);
        setSelectedId((current) => current ?? page[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) toast.error(errorMessage(error));
      } finally {
        endActivity(activity);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      endActivity(activity);
    };
  }, [beginActivity, endActivity, path, pin, repoPath]);

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    const activity = beginActivity("Loading file history", path);
    try {
      const page = await gitApi.fileCommits(repoPath, path, PAGE, fetched);
      setCommits((current) => [
        ...current,
        ...page.filter((item) => !current.some((have) => have.id === item.id)),
      ]);
      setFetched((count) => count + page.length);
      setHasMore(page.length === PAGE);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      endActivity(activity);
      setLoading(false);
    }
  }

  // Before a rename the file had another name, and its diff lives under that one.
  const diffPath = commits.find((commit) => commit.id === selectedId)?.path ?? path;
  const diffKey = selectedId ? `${selectedId}\0${diffPath}` : null;
  const diff = loadedDiff && loadedDiff.key === diffKey ? loadedDiff.diff : null;

  useEffect(() => {
    if (!selectedId || !diffKey) return;
    let cancelled = false;
    void gitApi
      .getCommitDiff(repoPath, selectedId, diffPath)
      .then((next) => {
        if (!cancelled) setLoadedDiff({ key: diffKey, diff: next });
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [diffKey, diffPath, repoPath, selectedId]);

  return (
    <ResizablePanelGroup
      id="file-history"
      orientation="vertical"
      className="min-h-0 min-w-0 flex-1"
      groupRef={layout.groupRef}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel id="file-commits" defaultSize="42%" minSize="18%">
        <FileHistory
          commits={commits}
          loading={loading}
          hasMore={hasMore}
          selectedId={selectedId}
          avatarProvider={avatarProvider}
          onSelect={setSelectedId}
          onLoadMore={() => void loadMore()}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="file-diff" defaultSize="58%" minSize="20%">
        <FileCommitDiff diff={diff} loading={Boolean(selectedId) && !diff} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function DirRows({
  dir,
  depth,
  entries,
  open,
  selected,
  onToggle,
  onOpenFile,
}: {
  dir: string;
  depth: number;
  entries: Record<string, DirEntry[]>;
  open: Set<string>;
  selected: string | null;
  onToggle: (dir: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const items = entries[dir];
  if (!items) return null;
  return (
    <>
      {items.map((item) => {
        const expanded = item.dir && open.has(item.path);
        return (
          <div key={item.path}>
            <button
              type="button"
              className={cn(
                "flex h-7 w-full items-center gap-1 pr-2 text-left text-xs hover:bg-muted/70",
                selected === item.path && "bg-muted",
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (item.dir ? onToggle(item.path) : onOpenFile(item.path))}
            >
              {item.dir ? (
                <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              {item.dir ? (
                expanded ? <FolderOpenIcon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
            </button>
            {expanded ? (
              <DirRows
                dir={item.path}
                depth={depth + 1}
                entries={entries}
                open={open}
                selected={selected}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

const BLAME_COLORS = [
  "#7dd3fc",
  "#86efac",
  "#fcd34d",
  "#f9a8d4",
  "#c4b5fd",
  "#fdba74",
  "#67e8f9",
  "#bef264",
  "#fda4af",
  "#a5b4fc",
];

function blameColor(commitId: string) {
  let hash = 0;
  for (let index = 0; index < commitId.length; index += 1) {
    hash = (hash * 33 + commitId.charCodeAt(index)) >>> 0;
  }
  return BLAME_COLORS[hash % BLAME_COLORS.length];
}

function blameWhen(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (date.getFullYear() === new Date().getFullYear()) return `${month}-${day}`;
  return `${date.getFullYear()}-${month}-${day}`;
}

const FILE_ROW_HEIGHT = 20;

interface BlameRow {
  text: string;
  hunk: BlameHunk | null;
  head: boolean;
  uncommitted: boolean;
}

function blameRows(text: string, hunks: BlameHunk[] | null, blameLoading: boolean): BlameRow[] {
  const lines = text.length === 0 ? [] : text.split("\n");
  let hunkIndex = 0;
  let previousId: string | null | undefined;
  return lines.map((line, index) => {
    while (hunks && hunkIndex < hunks.length && hunks[hunkIndex].start + hunks[hunkIndex].count <= index) {
      hunkIndex += 1;
    }
    const hunk =
      hunks && hunkIndex < hunks.length && hunks[hunkIndex].start <= index ? hunks[hunkIndex] : null;
    const id = hunk?.commitId ?? null;
    const uncommitted = !blameLoading && hunks != null && id == null && previousId !== null;
    previousId = id;
    return { text: line, hunk, head: hunk != null && hunk.start === index, uncommitted };
  });
}

const FileBrowse = memo(function FileBrowse({
  textLoading,
  blameLoading,
  binary,
  text,
  hunks,
  onOpenCommit,
}: {
  textLoading: boolean;
  blameLoading: boolean;
  binary: boolean;
  text: string | null;
  hunks: BlameHunk[] | null;
  onOpenCommit: (commitId: string) => void;
}) {
  const rows = useMemo(() => blameRows(text ?? "", hunks, blameLoading), [blameLoading, hunks, text]);
  const gutter = useMemo(
    () =>
      (hunks ?? []).reduce(
        (widest, hunk) => Math.max(widest, `${blameWhen(hunk.time)} ${hunk.author}`.length),
        14,
      ),
    [hunks],
  );
  const widest = useMemo(
    () => rows.reduce((max, row) => Math.max(max, textColumns(row.text)), 0),
    [rows],
  );
  const visibleRows = useWindowedRows(rows.length, FILE_ROW_HEIGHT);

  if (textLoading || text === null) return <DiffSkeleton label="Loading file" />;
  if (binary) {
    return <div className="p-4 text-sm text-muted-foreground">Binary file</div>;
  }
  const columns = `${gutter + 2}ch 2.75rem minmax(0,1fr)`;
  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={visibleRows.viewportRef}>
      <div
        className="font-mono text-[12px] leading-5 [tab-size:4]"
        style={{ minWidth: `calc(${gutter + 2}ch + 3.75rem + ${widest}ch)` }}
      >
        <div style={{ height: visibleRows.before }} />
        {rows.slice(visibleRows.start, visibleRows.end).map((row, offset) => {
          const index = visibleRows.start + offset;
          const { hunk, head } = row;
          return (
            <div key={index} className="grid h-5" style={{ gridTemplateColumns: columns }}>
              {blameLoading ? (
                <span className={cn("mx-2 my-1 h-3 rounded-sm bg-muted/60", index < 12 && "animate-pulse")} />
              ) : (
                <button
                  type="button"
                  disabled={!hunk}
                  tabIndex={head ? 0 : -1}
                  title={hunk ? `${hunk.author} · ${formatAbsoluteTime(hunk.time)}` : "Not committed"}
                  className={cn("whitespace-nowrap px-2 text-left text-[11px]", !hunk && "text-muted-foreground italic")}
                  style={head && hunk ? { color: blameColor(hunk.commitId) } : undefined}
                  onClick={() => {
                    if (hunk) onOpenCommit(hunk.commitId);
                  }}
                >
                  {head && hunk ? `${blameWhen(hunk.time)} ${hunk.author}` : row.uncommitted ? "Not committed" : ""}
                </button>
              )}
              <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">{index + 1}</span>
              <span className="whitespace-pre pr-4">{row.text}</span>
            </div>
          );
        })}
        <div style={{ height: visibleRows.after }} />
      </div>
    </ScrollArea>
  );
});

function FileHistory({
  commits,
  loading,
  hasMore,
  selectedId,
  avatarProvider,
  onSelect,
  onLoadMore,
}: {
  commits: CommitSummary[];
  loading: boolean;
  hasMore: boolean;
  selectedId: string | null;
  avatarProvider: AvatarProvider;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <ScrollArea className="h-full">
      {commits.length === 0 && loading ? <DiffSkeleton label="Loading history" /> : null}
      {commits.length === 0 && !loading ? (
        <div className="p-4 text-sm text-muted-foreground">No commits for this file</div>
      ) : null}
      {commits.map((commit) => (
        <button
          key={commit.id}
          ref={commit.id === selectedId ? selectedRef : undefined}
          type="button"
          className={cn(
            "flex h-8 w-full items-center gap-3 px-3 text-left hover:bg-muted/70",
            commit.id === selectedId && "bg-muted",
          )}
          onClick={() => onSelect(commit.id)}
        >
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">{commit.shortId}</span>
          <span className="min-w-0 flex-1 truncate text-sm">{commit.summary || "(no message)"}</span>
          <span className="flex w-28 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <AuthorAvatar name={commit.authorName} email={commit.authorEmail} provider={avatarProvider} />
            <span className="truncate">{commit.authorName}</span>
          </span>
          <span className="w-[7.25rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {formatAbsoluteTime(commit.timestamp)}
          </span>
        </button>
      ))}
      {hasMore ? (
        <div className="px-3 py-2 text-center">
          <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={onLoadMore}>
            {loading ? "Loading" : "Load earlier commits"}
          </Button>
        </div>
      ) : null}
    </ScrollArea>
  );
}

function FileCommitDiff({ diff, loading }: { diff: FileDiff | null; loading: boolean }) {
  if (!diff && loading) return <DiffSkeleton />;
  if (!diff) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a commit
      </div>
    );
  }
  if (diff.binary) return <p className="p-4 text-sm text-muted-foreground">Binary file</p>;
  if (diff.lines.length === 0) return <p className="p-4 text-sm text-muted-foreground">No textual diff</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiffLines diff={diff} />
    </div>
  );
}
