import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SquarePenIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { AuthorAvatar } from "@/components/author-avatar";
import { avatarColor, avatarInitial, avatarSeed } from "@/lib/avatar";
import { DiffLines } from "@/components/diff-viewer";
import { FileTree } from "@/components/file-tree";
import { ImageDiff, isImagePath } from "@/components/image-diff";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { languageFor, styleSpans, textColumns, type TokenRange } from "@/lib/diff-text";
import { formatAbsoluteTime, formatBlameWhen } from "@/lib/format";
import { errorMessage, gitApi } from "@/lib/git";
import { dirsToReload, touchesFile } from "@/lib/repo-paths";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useGitPick, useGitSelect } from "@/state/git-context";
import { usePanelGroupLayout } from "@/state/use-panel-group-layout";
import { useRepoChanged } from "@/state/use-repo-changed";
import type { BlameHunk, CommitSummary, DirEntry, FileDiff } from "@/types/git";

const PAGE = 80;

function ancestorDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function FilesBrowser() {
  const shell = usePanelGroupLayout("files");
  const repoPath = useGitSelect((state) => state.snapshot?.repo.path ?? "");
  const { openInEditor } = useGitPick(["openInEditor"]);
  const fileFocus = useGitSelect((state) => state.fileFocus);
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(fileFocus ? ancestorDirs(fileFocus.path) : []),
  );
  const [path, setPath] = useState<string | null>(fileFocus?.path ?? null);
  const [mode, setMode] = useState<"browse" | "history">(fileFocus?.mode ?? "browse");
  // A commit picked from blame, to select when the history opens.
  const [pin, setPin] = useState<string | null>(null);
  const [shownFocus, setShownFocus] = useState(fileFocus?.nonce ?? 0);
  if (fileFocus && fileFocus.nonce !== shownFocus) {
    setShownFocus(fileFocus.nonce);
    setPath(fileFocus.path);
    setMode(fileFocus.mode);
    setPin(null);
    setOpen((current) => new Set([...current, ...ancestorDirs(fileFocus.path)]));
  }
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

  // Folders opened on another view's behalf are listed here.
  useEffect(() => {
    for (const dir of open) {
      if (dir && !entriesRef.current[dir]) void loadDir(dir, true);
    }
  }, [loadDir, open]);

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
            <FileTree
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
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Open in editor"
                title="Open in editor"
                onClick={() => void openInEditor(path)}
              >
                <SquarePenIcon />
              </Button>
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
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Close"
                title="Close"
                onClick={() => {
                  setPath(null);
                  setPin(null);
                }}
              >
                <XIcon />
              </Button>
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
      path={path}
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
  const ignoreWhitespace = useGitSelect((state) => state.prefs.diffIgnoreWhitespace);
  const diffKey = selectedId ? `${selectedId}\0${diffPath}\0${ignoreWhitespace}` : null;
  const diff = loadedDiff && loadedDiff.key === diffKey ? loadedDiff.diff : null;

  useEffect(() => {
    if (!selectedId || !diffKey) return;
    let cancelled = false;
    void gitApi
      .getCommitDiff(repoPath, selectedId, diffPath, ignoreWhitespace)
      .then((next) => {
        if (!cancelled) setLoadedDiff({ key: diffKey, diff: next });
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [diffKey, diffPath, ignoreWhitespace, repoPath, selectedId]);

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
          onSelect={setSelectedId}
          onLoadMore={() => void loadMore()}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="file-diff" defaultSize="58%" minSize="20%">
        <FileCommitDiff diff={diff} commitId={selectedId} loading={Boolean(selectedId) && !diff} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

const FILE_ROW_HEIGHT = 20;
const BLAME_GUTTER = "14rem";
const BLAME_FILL = "color-mix(in oklch, var(--foreground) 5%, var(--background))";
const BLAME_HOT = "color-mix(in oklch, var(--foreground) 16%, var(--background))";

/** Recent commits stay solid. Years-old lines fade back, like a GitLens heatmap. */
function blameHeat(timestamp: number): number {
  const days = Math.max(0, (Date.now() - timestamp * 1000) / 86_400_000);
  if (days <= 14) return 1;
  if (days <= 90) return 0.78;
  if (days <= 365) return 0.55;
  if (days <= 365 * 4) return 0.4;
  return 0.32;
}

interface BlameRow {
  text: string;
  hunk: BlameHunk | null;
  /** First line of a commit, or the first line of an uncommitted run. */
  label: boolean;
  /** No commit covers this line. */
  dirty: boolean;
  /** One contiguous run of the same commit, or one uncommitted run. */
  block: number;
  /** Shared by every line of the block. 0 when the line has no commit. */
  heat: number;
  /** Shared by every line of the block. */
  tip: string | undefined;
  /** Set on the first line of a commit. */
  when: string | null;
}

function blameRows(lines: string[], hunks: BlameHunk[] | null, blameLoading: boolean): BlameRow[] {
  let hunkIndex = 0;
  let previousId: string | null | undefined;
  let block = -1;
  let heat = 0;
  let tip: string | undefined;
  let when: string | null = null;
  return lines.map((line, index) => {
    while (hunks && hunkIndex < hunks.length && hunks[hunkIndex].start + hunks[hunkIndex].count <= index) {
      hunkIndex += 1;
    }
    const hunk =
      hunks && hunkIndex < hunks.length && hunks[hunkIndex].start <= index ? hunks[hunkIndex] : null;
    const id = hunk?.commitId ?? null;
    const starts = id !== previousId;
    if (starts) block += 1;
    const dirty = !blameLoading && hunks != null && hunk == null;
    if (starts) {
      if (hunk) {
        heat = blameHeat(hunk.time);
        when = formatBlameWhen(hunk.time);
        tip = `${hunk.author}\n${formatAbsoluteTime(hunk.time)}\n${hunk.commitId.slice(0, 7)}`;
      } else if (dirty) {
        heat = 0;
        when = null;
        tip = "Not committed";
      } else {
        heat = 0;
        when = null;
        tip = undefined;
      }
    }
    previousId = id;
    return { text: line, hunk, label: starts && (hunk != null || dirty), dirty, block, heat, tip, when };
  });
}

type TextHighlighter = (lines: string[], language: string) => TokenRange[][] | null;
let loadedTextHighlighter: TextHighlighter | null = null;

function useFileSyntax(path: string, lines: string[] | null) {
  const language = lines == null ? null : languageFor(path);
  const [highlighter, setHighlighter] = useState<TextHighlighter | null>(() => loadedTextHighlighter);
  const [paint, setPaint] = useState<{ source: string[]; ranges: TokenRange[][] } | null>(null);
  useEffect(() => {
    if (!language || highlighter) return;
    let live = true;
    void import("@/lib/highlight").then((module) => {
      loadedTextHighlighter = module.highlightText;
      if (live) setHighlighter(() => module.highlightText);
    });
    return () => {
      live = false;
    };
  }, [highlighter, language]);
  // Color after the file and blame have painted. Prism on a long file is the
  // slow part, and it used to run inside the same render that showed the text.
  useEffect(() => {
    if (!language || !highlighter || lines == null) return;
    let cancelled = false;
    const source = lines;
    const run = () => {
      if (cancelled) return;
      const next = highlighter(source, language);
      if (cancelled || !next) return;
      startTransition(() => {
        if (!cancelled) setPaint({ source, ranges: next });
      });
    };
    const idle = window.requestIdleCallback?.(run, { timeout: 150 });
    const timer = idle == null ? window.setTimeout(run, 1) : undefined;
    return () => {
      cancelled = true;
      if (idle != null) window.cancelIdleCallback(idle);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [highlighter, language, lines]);
  return paint && paint.source === lines ? paint.ranges : null;
}

function BlameAvatar({ name }: { name: string }) {
  const seed = avatarSeed(name, "");
  return (
    <span
      aria-hidden
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-medium text-white ring-1 ring-white/15"
      style={{ backgroundColor: avatarColor(seed) }}
    >
      {avatarInitial(seed)}
    </span>
  );
}

function BlameMargin({
  row,
  divided,
  hot,
  onOpenCommit,
}: {
  row: BlameRow;
  divided: boolean;
  hot: boolean;
  onOpenCommit: (commitId: string) => void;
}) {
  const { hunk, dirty, label } = row;
  const spine = hunk || dirty;
  const fill = hot ? BLAME_HOT : BLAME_FILL;
  const body = (
    <>
      {spine ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{
            backgroundColor: dirty ? "var(--diff-add)" : "var(--foreground)",
            opacity: dirty ? 0.95 : hot ? Math.min(1, row.heat + 0.35) : row.heat,
          }}
        />
      ) : null}
      {label && hunk ? (
        <>
          <BlameAvatar name={hunk.author} />
          <span className={cn("min-w-0 flex-1 truncate text-[11px]", hot ? "text-foreground" : "text-foreground/80")}>
            {hunk.author}
          </span>
          <span className="w-[4.75rem] shrink-0 text-right font-mono text-[11px] tabular-nums whitespace-nowrap text-muted-foreground">
            {row.when}
          </span>
        </>
      ) : label && dirty ? (
        <span className="truncate text-[11px] text-muted-foreground italic">Not committed</span>
      ) : null}
    </>
  );
  const className = cn(
    "relative sticky left-0 z-20 flex h-5 w-full min-w-0 items-center gap-1.5 overflow-hidden border-r border-border pr-2 pl-2.5 font-sans leading-none select-none",
    divided && "shadow-[inset_0_1px_0_0_var(--border)]",
  );
  if (!hunk) {
    return (
      <div className={className} style={{ background: fill }} title={dirty ? "Not committed" : undefined}>
        {body}
      </div>
    );
  }
  const open = () => onOpenCommit(hunk.commitId);
  if (!label) {
    return (
      <div
        className={cn(className, "cursor-pointer")}
        style={{ background: fill }}
        title={row.tip}
        onClick={open}
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={row.tip}
      aria-label={`${hunk.author}, ${row.when}`}
      className={cn(
        className,
        "cursor-pointer text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
      )}
      style={{ background: fill }}
      onClick={open}
    >
      {body}
    </button>
  );
}

function blockFromEvent(event: { target: EventTarget | null }): number | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const value = target.closest("[data-block]")?.getAttribute("data-block");
  if (value == null) return null;
  const block = Number(value);
  return Number.isNaN(block) ? null : block;
}

const FILE_COLUMNS = `${BLAME_GUTTER} 2.75rem minmax(0,1fr)`;

const FileLine = memo(function FileLine({
  row,
  index,
  hot,
  ranges,
  blameLoading,
  onOpenCommit,
}: {
  row: BlameRow;
  index: number;
  hot: boolean;
  ranges: TokenRange[] | undefined;
  blameLoading: boolean;
  onOpenCommit: (commitId: string) => void;
}) {
  return (
    <div
      data-block={row.hunk || row.dirty ? row.block : undefined}
      className="grid h-5"
      style={{ gridTemplateColumns: FILE_COLUMNS, background: hot ? BLAME_HOT : undefined }}
    >
      {blameLoading ? (
        <span
          className="sticky left-0 z-20 flex h-5 items-center border-r border-border pr-2 pl-2.5"
          style={{ background: BLAME_FILL }}
        >
          <span className={cn("h-3 flex-1 rounded-sm bg-foreground/10", index < 12 && "animate-pulse")} />
        </span>
      ) : (
        <BlameMargin row={row} divided={index > 0 && row.label} hot={hot} onOpenCommit={onOpenCommit} />
      )}
      <span
        className="sticky z-10 pr-2 text-right text-muted-foreground/70 tabular-nums select-none"
        style={{ left: BLAME_GUTTER, background: hot ? BLAME_HOT : "var(--background)" }}
      >
        {index + 1}
      </span>
      <span className="whitespace-pre pr-4">
        <HighlightedLine text={row.text} ranges={ranges} />
      </span>
    </div>
  );
});

const FileBrowse = memo(function FileBrowse({
  path,
  textLoading,
  blameLoading,
  binary,
  text,
  hunks,
  onOpenCommit,
}: {
  path: string;
  textLoading: boolean;
  blameLoading: boolean;
  binary: boolean;
  text: string | null;
  hunks: BlameHunk[] | null;
  onOpenCommit: (commitId: string) => void;
}) {
  const lines = useMemo(() => (text == null || text.length === 0 ? [] : text.split("\n")), [text]);
  const rows = useMemo(() => blameRows(lines, hunks, blameLoading), [blameLoading, hunks, lines]);
  const syntax = useFileSyntax(path, binary || text == null ? null : lines);
  const widest = useMemo(() => lines.reduce((max, line) => Math.max(max, textColumns(line)), 0), [lines]);
  const visibleRows = useWindowedRows(rows.length, FILE_ROW_HEIGHT, 12, 640);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [paintedHunks, setPaintedHunks] = useState(hunks);
  if (paintedHunks !== hunks) {
    setPaintedHunks(hunks);
    setActiveBlock(null);
  }

  useEffect(() => {
    const node = visibleRows.viewport;
    if (!node) return;
    const clear = () => setActiveBlock(null);
    node.addEventListener("scroll", clear, { passive: true });
    return () => node.removeEventListener("scroll", clear);
  }, [visibleRows.viewport]);

  if (textLoading || text === null) return <DiffSkeleton label="Loading file" />;
  if (binary) {
    return <div className="p-4 text-sm text-muted-foreground">Binary file</div>;
  }
  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={visibleRows.viewportRef}>
      <div
        className="font-mono text-[12px] leading-5 [tab-size:4]"
        style={{ minWidth: `calc(${BLAME_GUTTER} + 3.75rem + ${widest}ch)` }}
        onMouseOver={(event) => {
          const next = blockFromEvent(event);
          setActiveBlock((current) => (current === next ? current : next));
        }}
        onMouseLeave={() => setActiveBlock(null)}
      >
        <div style={{ height: visibleRows.before }} />
        {rows.slice(visibleRows.start, visibleRows.end).map((row, offset) => {
          const index = visibleRows.start + offset;
          const hot = activeBlock === row.block && (row.hunk != null || row.dirty);
          return (
            <FileLine
              key={index}
              row={row}
              index={index}
              hot={hot}
              ranges={syntax?.[index]}
              blameLoading={blameLoading}
              onOpenCommit={onOpenCommit}
            />
          );
        })}
        <div style={{ height: visibleRows.after }} />
      </div>
    </ScrollArea>
  );
});

function HighlightedLine({ text, ranges }: { text: string; ranges: TokenRange[] | undefined }) {
  if (!ranges?.length) return text;
  return styleSpans([{ text, changed: false }], ranges).map((span, index) =>
    span.text ? (
      <span key={index} className={span.cls ? `tok-${span.cls}` : undefined}>
        {span.text}
      </span>
    ) : null,
  );
}

function FileHistory({
  commits,
  loading,
  hasMore,
  selectedId,
  onSelect,
  onLoadMore,
}: {
  commits: CommitSummary[];
  loading: boolean;
  hasMore: boolean;
  selectedId: string | null;
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
            <AuthorAvatar name={commit.authorName} email={commit.authorEmail} />
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

function FileCommitDiff({
  diff,
  commitId,
  loading,
}: {
  diff: FileDiff | null;
  commitId: string | null;
  loading: boolean;
}) {
  if (!diff && loading) return <DiffSkeleton />;
  if (!diff) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a commit
      </div>
    );
  }
  if (diff.binary && commitId && isImagePath(diff.path)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ImageDiff source={{ kind: "commit", oid: commitId, path: diff.path, oldPath: diff.oldPath }} />
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
