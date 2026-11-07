import { t, useTranslation } from "@/i18n";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { nestSearchNodes, type SearchNode } from "@/lib/file-search";
import { fileTreeRows } from "@/lib/file-tree-rows";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";

export interface FileTreeEntry {
  path: string;
  name: string;
  dir: boolean;
  ignored?: boolean;
  icon?: ReactNode;
  iconTitle?: ReactNode;
}

interface FileTreeProps {
  dir: string;
  depth: number;
  entries: Record<string, FileTreeEntry[]>;
  open: Set<string>;
  selected: string | null;
  onToggle: (dir: string) => void;
  onOpenFile: (path: string) => void;
  trailing?: (entry: FileTreeEntry) => ReactNode;
  menu?: (entry: FileTreeEntry) => ReactNode;
  loading?: ReadonlySet<string>;
}

export function FileTree(props: FileTreeProps) {
  const { dir, depth, entries, open } = props;
  const items = entries[dir];
  if (!items) return null;
  return (
    <>
      {items.map((item) => {
        const expanded = item.dir && open.has(item.path);
        return (
          <div key={item.path}>
            <TreeRow {...props} item={item} depth={depth} expanded={expanded} />
            {expanded ? <FileTree {...props} dir={item.path} depth={depth + 1} /> : null}
          </div>
        );
      })}
    </>
  );
}

/** A scrolling tree that mounts one screen of rows, regardless of folder size. */
export function VirtualFileTree(props: FileTreeProps) {
  const { dir, depth, entries, open, selected } = props;
  const rows = useMemo(() => fileTreeRows(entries, open, dir, depth), [entries, open, dir, depth]);
  const windowed = useWindowedRows(rows.length, 28, 10, 640);
  const revealed = useRef<string | null>(null);
  const viewportHeight = windowed.viewport?.clientHeight ?? 0;
  useLayoutEffect(() => {
    const viewport = windowed.viewport;
    if (!selected) {
      revealed.current = null;
      return;
    }
    if (!viewport || viewportHeight === 0 || selected === revealed.current) return;
    const index = rows.findIndex((row) => row.entry.path === selected);
    if (index < 0) return;
    revealed.current = selected;
    const top = index * 28;
    if (top < viewport.scrollTop) viewport.scrollTo({ top });
    else if (top + 28 > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: top + 28 - viewport.clientHeight });
    }
  }, [rows, selected, windowed.viewport, viewportHeight]);
  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={windowed.viewportRef} scrollbars="vertical">
      <div style={{ paddingTop: windowed.before, paddingBottom: windowed.after }}>
        {rows.slice(windowed.start, windowed.end).map(({ entry, depth: rowDepth }) => (
          <TreeRow
            key={entry.path}
            {...props}
            item={entry}
            depth={rowDepth}
            expanded={entry.dir && open.has(entry.path)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function TreeRow({
  item, depth, expanded, selected, onToggle, onOpenFile, trailing, menu, loading,
}: Pick<FileTreeProps, "depth" | "selected" | "onToggle" | "onOpenFile" | "trailing" | "menu" | "loading"> & {
  item: FileTreeEntry;
  expanded: boolean;
}) {
  useTranslation();
  const busy = loading?.has(item.path) ?? false;
  const tip = item.iconTitle || (item.ignored ? t("git-files.ignored") : item.name);
  const row = (
    <button
      type="button"
      data-tree-path={item.path}
      aria-expanded={item.dir ? expanded : undefined}
      aria-busy={busy || undefined}
      className={cn(
        "flex h-7 w-full items-center pr-2 text-left text-xs hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected === item.path && "bg-muted",
        item.ignored && "text-muted-foreground",
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => (item.dir ? onToggle(item.path) : onOpenFile(item.path))}
      onContextMenu={() => {
        if (!item.dir) onOpenFile(item.path);
      }}
    >
      <HoverTip label={tip} className="max-w-lg">
        <span className="inline-flex w-fit min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
          {busy ? (
            <LoaderCircleIcon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          ) : item.dir ? (
            <ChevronRightIcon className={cn("size-3.5 shrink-0 motion-safe:transition-transform", expanded && "rotate-90")} />
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          {item.dir ? (
            expanded ? (
              <FolderOpenIcon className="size-3.5 shrink-0" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0" />
            )
          ) : item.icon ? (
            <span className="inline-flex shrink-0">{item.icon}</span>
          ) : (
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate font-mono">{item.name}</span>
        </span>
      </HoverTip>
      {trailing ? <span className="ml-auto pl-2">{trailing(item)}</span> : null}
    </button>
  );
  return menu ? (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      {menu(item)}
    </ContextMenu>
  ) : row;
}

export function FileTreeFilter({
  title,
  query,
  onQuery,
  leading,
  placeholder,
}: {
  title: string;
  query: string;
  onQuery: (value: string) => void;
  leading?: ReactNode;
  placeholder?: string;
}) {
  useTranslation();
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
      {leading ?? <span className="shrink-0 px-1 text-sm font-medium">{title}</span>}
      <div className="relative min-w-0 flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onQuery("");
            }
          }}
          placeholder={placeholder ?? t("git-files.filterFiles")}
          aria-label={t("git-files.filterTitle", { title })}
          spellCheck={false}
          className="h-7 pl-7"
        />
      </div>
    </div>
  );
}

function treeEntry(node: SearchNode, toPath: (relative: string) => string): FileTreeEntry {
  return {
    path: toPath(node.relative),
    name: node.relative.split("/").pop() ?? node.relative,
    dir: node.dir,
  };
}

function buildFilteredTree(
  nodes: SearchNode[],
  toPath: (relative: string) => string,
  decorate?: (node: SearchNode, entry: FileTreeEntry) => FileTreeEntry,
) {
  const nested = nestSearchNodes(nodes);
  const entries: Record<string, FileTreeEntry[]> = {};
  for (const [parent, list] of Object.entries(nested.entries)) {
    entries[toPath(parent)] = list.map((node) => {
      const entry = treeEntry(node, toPath);
      return decorate ? decorate(node, entry) : entry;
    });
  }
  return {
    entries,
    open: new Set(nested.open.map((relative) => toPath(relative))),
  };
}

export function FilteredFileTree({
  nodes,
  toPath,
  selected,
  onOpenFile,
  onLoadDir,
  menu,
  decorate,
  virtualized = false,
}: {
  nodes: SearchNode[];
  toPath: (relative: string) => string;
  selected: string | null;
  onOpenFile: (path: string) => void;
  onLoadDir?: (path: string) => Promise<FileTreeEntry[] | null>;
  menu?: (entry: FileTreeEntry) => ReactNode;
  decorate?: (node: SearchNode, entry: FileTreeEntry) => FileTreeEntry;
  virtualized?: boolean;
}) {
  useTranslation();
  const [seen, setSeen] = useState(nodes);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(generation);
  const requests = useRef(new Map<string, number>());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [tree, setTree] = useState(() => buildFilteredTree(nodes, toPath, decorate));
  if (seen !== nodes) {
    setSeen(nodes);
    setGeneration((current) => current + 1);
    setTree(buildFilteredTree(nodes, toPath, decorate));
    setLoading(new Set());
  }
  useLayoutEffect(() => {
    generationRef.current = generation;
    return () => {
      generationRef.current = generation + 1;
    };
  }, [generation]);

  async function toggle(path: string) {
    if (tree.open.has(path)) {
      setTree((current) => {
        const open = new Set(current.open);
        open.delete(path);
        return { ...current, open };
      });
      return;
    }
    setTree((current) => ({ ...current, open: new Set(current.open).add(path) }));
    if (!tree.entries[path] && onLoadDir && requests.current.get(path) !== generation) {
      const token = generation;
      requests.current.set(path, token);
      setLoading((current) => new Set(current).add(path));
      try {
        const children = await onLoadDir(path);
        if (token !== generationRef.current || !children) return;
        setTree((current) => ({ ...current, entries: { ...current.entries, [path]: children } }));
      } finally {
        if (requests.current.get(path) === token) requests.current.delete(path);
        if (token === generationRef.current) {
          setLoading((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        }
      }
    }
  }

  if (nodes.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t("git-files.noMatches")}</p>;
  }

  const Tree = virtualized ? VirtualFileTree : FileTree;
  return (
    <Tree
      dir={toPath("")}
      depth={0}
      entries={tree.entries}
      open={tree.open}
      selected={selected}
      onToggle={(path) => void toggle(path)}
      onOpenFile={onOpenFile}
      menu={menu}
      loading={loading}
    />
  );
}
