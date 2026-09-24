import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatAbsoluteTime } from "@/lib/format";
import { errorMessage, gitApi } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import type { AvatarProvider, BlameHunk, CommitSummary, DirEntry, FileDiff, PanelLayoutId } from "@/types/git";

const PAGE = 80;

function usePanelGroupLayout(id: PanelLayoutId) {
  const { prefs, updatePanelLayout } = useGit();
  const groupRef = useGroupRef();
  const layout = prefs.panelLayouts[id];
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout(layoutRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [groupRef]);

  return {
    groupRef,
    defaultLayout: layout,
    onLayoutChanged: (next: Layout, meta: { isUserInteraction: boolean }) => {
      if (meta.isUserInteraction) updatePanelLayout(id, next);
    },
  };
}

export function FilesBrowser() {
  const shell = usePanelGroupLayout("files");
  const historyLayout = usePanelGroupLayout("fileHistory");
  const { snapshot, prefs, beginActivity, endActivity } = useGit();
  const repoPath = snapshot?.repo.path ?? "";
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"browse" | "history">("browse");
  const [fileText, setFileText] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [textLoading, setTextLoading] = useState(false);
  const [hunks, setHunks] = useState<BlameHunk[] | null>(null);
  const [blameLoading, setBlameLoading] = useState(false);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [commitsHasMore, setCommitsHasMore] = useState(false);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const pinnedCommit = useRef<string | null>(null);

  const loadDir = useCallback(
    async (dir: string) => {
      if (!repoPath) return;
      try {
        const items = await gitApi.listDirectory(repoPath, dir);
        setEntries((current) => ({ ...current, [dir]: items }));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [repoPath],
  );

  useEffect(() => {
    setEntries({});
    setOpen(new Set());
    setPath(null);
    void loadDir("");
  }, [loadDir]);

  useEffect(() => {
    if (!repoPath || !path || mode !== "browse") return;
    let cancelled = false;
    setTextLoading(true);
    setBlameLoading(true);
    setFileText(null);
    setHunks(null);
    setBinary(false);
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
  }, [beginActivity, endActivity, mode, path, repoPath]);

  const loadHistory = useCallback(
    async (reset: boolean) => {
      if (!repoPath || !path) return;
      setCommitsLoading(true);
      const activity = beginActivity("Loading file history", path);
      try {
        const skip = reset ? 0 : commits.length;
        const page = await gitApi.fileCommits(repoPath, path, PAGE, skip);
        setCommits((current) => (reset ? page : [...current, ...page.filter((item) => !current.some((have) => have.id === item.id))]));
        setCommitsHasMore(page.length === PAGE);
        if (reset) {
          setSelectedId((current) => current && page.some((item) => item.id === current) ? current : (page[0]?.id ?? current));
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        endActivity(activity);
        setCommitsLoading(false);
      }
    },
    [beginActivity, commits.length, endActivity, path, repoPath],
  );

  useEffect(() => {
    if (mode !== "history" || !path || !repoPath) return;
    const keep = pinnedCommit.current;
    pinnedCommit.current = null;
    let cancelled = false;
    setCommitsLoading(true);
    setDiff(null);
    const activity = beginActivity("Loading file history", path);
    void (async () => {
      try {
        const page = await gitApi.fileCommits(repoPath, path, PAGE, 0);
        if (cancelled) return;
        let items = page;
        if (keep && !page.some((commit) => commit.id === keep)) {
          const details = await gitApi.getCommitDetails(repoPath, keep);
          if (!cancelled) items = [details.commit, ...page];
        }
        if (cancelled) return;
        setCommits(items);
        setCommitsHasMore(page.length === PAGE);
        setSelectedId(keep ?? page[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) toast.error(errorMessage(error));
      } finally {
        endActivity(activity);
        if (!cancelled) setCommitsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      endActivity(activity);
    };
  }, [beginActivity, endActivity, mode, path, repoPath]);

  useEffect(() => {
    if (mode !== "history" || !repoPath || !path || !selectedId) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    void gitApi
      .getCommitDiff(repoPath, selectedId, path)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, path, repoPath, selectedId]);

  async function openBlameCommit(commitId: string) {
    setSelectedId(commitId);
    if (mode !== "history") {
      pinnedCommit.current = commitId;
      setMode("history");
      return;
    }
    if (!repoPath || commits.some((commit) => commit.id === commitId)) return;
    try {
      const details = await gitApi.getCommitDetails(repoPath, commitId);
      setCommits((current) =>
        current.some((commit) => commit.id === commitId) ? current : [details.commit, ...current],
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

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
                const next = new Set(open);
                if (next.has(dir)) next.delete(dir);
                else {
                  next.add(dir);
                  if (!entries[dir]) await loadDir(dir);
                }
                setOpen(next);
              }}
              onOpenFile={setPath}
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
                  onClick={() => setMode("history")}
                >
                  History
                </Button>
              </div>
            </div>
            {mode === "browse" ? (
              <FileBrowse
                textLoading={textLoading}
                blameLoading={blameLoading}
                binary={binary}
                text={fileText}
                hunks={hunks}
                onOpenCommit={(commitId) => void openBlameCommit(commitId)}
              />
            ) : (
              <ResizablePanelGroup
                id="file-history"
                orientation="vertical"
                className="min-h-0 min-w-0 flex-1"
                groupRef={historyLayout.groupRef}
                defaultLayout={historyLayout.defaultLayout}
                onLayoutChanged={historyLayout.onLayoutChanged}
              >
                <ResizablePanel id="file-commits" defaultSize="42%" minSize="18%">
                  <FileHistory
                    commits={commits}
                    loading={commitsLoading}
                    hasMore={commitsHasMore}
                    selectedId={selectedId}
                    avatarProvider={prefs.avatarProvider}
                    onSelect={setSelectedId}
                    onLoadMore={() => void loadHistory(false)}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel id="file-diff" defaultSize="58%" minSize="20%">
                  <FileCommitDiff diff={diff} loading={Boolean(selectedId) && !diff} />
                </ResizablePanel>
              </ResizablePanelGroup>
            )}
          </div>
        )}
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

function FileBrowse({
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
  if (textLoading || text === null) return <DiffSkeleton label="Loading file" />;
  if (binary) {
    return <div className="p-4 text-sm text-muted-foreground">Binary file</div>;
  }
  const lines = text.length === 0 ? [] : text.split("\n");
  let gutter = 14;
  for (const hunk of hunks ?? []) {
    gutter = Math.max(gutter, `${blameWhen(hunk.time)} ${hunk.author}`.length);
  }
  let hunkIndex = 0;
  let previousId: string | null | undefined;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="min-w-max font-mono text-[12px] leading-5">
        {lines.map((line, index) => {
          while (
            hunks &&
            hunkIndex < hunks.length &&
            hunks[hunkIndex].start + hunks[hunkIndex].count <= index
          ) {
            hunkIndex += 1;
          }
          const hunk =
            hunks && hunkIndex < hunks.length && hunks[hunkIndex].start <= index
              ? hunks[hunkIndex]
              : null;
          const id = hunk?.commitId ?? null;
          const head = hunk != null && hunk.start === index;
          const uncommitted = !blameLoading && hunks != null && id == null && previousId !== null;
          previousId = id;
          return (
            <div
              key={index}
              className="grid"
              style={{ gridTemplateColumns: `${gutter + 2}ch 2.75rem minmax(0,1fr)` }}
            >
              {blameLoading ? (
                <span className={cn("mx-2 my-1 h-3 rounded-sm bg-muted/60", index < 12 && "animate-pulse")} />
              ) : (
                <button
                  type="button"
                  disabled={!hunk}
                  title={hunk ? `${hunk.author} · ${formatAbsoluteTime(hunk.time)}` : "Not committed"}
                  className={cn("whitespace-nowrap px-2 text-left text-[11px]", !hunk && "text-muted-foreground italic")}
                  style={head && hunk ? { color: blameColor(hunk.commitId) } : undefined}
                  onClick={() => {
                    if (hunk) onOpenCommit(hunk.commitId);
                  }}
                >
                  {head && hunk ? `${blameWhen(hunk.time)} ${hunk.author}` : uncommitted ? "Not committed" : ""}
                </button>
              )}
              <span className="pr-2 text-right text-muted-foreground/70 tabular-nums">{index + 1}</span>
              <span className="whitespace-pre pr-4">{line}</span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

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
    <ScrollArea className="h-full">
      <pre className="min-w-max font-mono text-[12px] leading-5 [tab-size:4]">
        {diff.lines.map((line, index) => (
          <div
            key={`${line.kind}-${index}-${line.oldLineno}-${line.newLineno}`}
            className={cn(
              "flex w-max min-w-full",
              line.kind === "add" && "bg-diff-add-bg text-diff-add",
              line.kind === "delete" && "bg-diff-del-bg text-diff-del",
              line.kind === "hunk" && "bg-muted/50 text-diff-hunk",
            )}
          >
            <span className="w-12 shrink-0 pr-2 text-right text-muted-foreground/70 tabular-nums">
              {line.kind === "hunk" ? "" : line.oldLineno ?? ""}
            </span>
            <span className="w-12 shrink-0 pr-2 text-right text-muted-foreground/70 tabular-nums">
              {line.kind === "hunk" ? "" : line.newLineno ?? ""}
            </span>
            <span className="w-5 shrink-0 text-center">
              {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : line.kind === "hunk" ? "" : " "}
            </span>
            <span className="whitespace-pre">{line.content || " "}</span>
          </div>
        ))}
      </pre>
    </ScrollArea>
  );
}
