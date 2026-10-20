import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon, SearchIcon } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/tooltip";
import { nestSearchNodes, type SearchNode } from "@/lib/file-search";
import { cn } from "@/lib/utils";

export interface FileTreeEntry {
  path: string;
  name: string;
  dir: boolean;
  ignored?: boolean;
  icon?: ReactNode;
  iconTitle?: ReactNode;
}

export function FileTree({
  dir,
  depth,
  entries,
  open,
  selected,
  onToggle,
  onOpenFile,
  trailing,
  menu,
}: {
  dir: string;
  depth: number;
  entries: Record<string, FileTreeEntry[]>;
  open: Set<string>;
  selected: string | null;
  onToggle: (dir: string) => void;
  onOpenFile: (path: string) => void;
  trailing?: (entry: FileTreeEntry) => ReactNode;
  menu?: (entry: FileTreeEntry) => ReactNode;
}) {
  const items = entries[dir];
  if (!items) return null;
  return (
    <>
      {items.map((item) => {
        const expanded = item.dir && open.has(item.path);
        const tip = item.iconTitle || (item.ignored ? "Ignored" : item.name);
        const row = (
            <button
              type="button"
              className={cn(
                "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs hover:bg-muted/70",
                selected === item.path && "bg-muted",
                item.ignored && "text-muted-foreground",
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (item.dir ? onToggle(item.path) : onOpenFile(item.path))}
              onContextMenu={() => {
                if (!item.dir) onOpenFile(item.path);
              }}
            >
              {item.dir ? (
                <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              {item.dir ? (
                expanded ? (
                  <FolderOpenIcon className="mr-1 size-3.5 shrink-0" />
                ) : (
                  <FolderIcon className="mr-1 size-3.5 shrink-0" />
                )
              ) : item.icon ? (
                <span className="mr-1 inline-flex shrink-0">{item.icon}</span>
              ) : (
                <FileIcon className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
              {trailing ? trailing(item) : null}
            </button>
        );
        return (
          <div key={item.path}>
            {menu ? (
              <ContextMenu>
                <HoverTip label={tip} className="max-w-lg">
                  <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                </HoverTip>
                {menu(item)}
              </ContextMenu>
            ) : (
              <HoverTip label={tip} className="max-w-lg">{row}</HoverTip>
            )}
            {expanded ? (
              <FileTree
                dir={item.path}
                depth={depth + 1}
                entries={entries}
                open={open}
                selected={selected}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                trailing={trailing}
                menu={menu}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function FileTreeFilter({
  title,
  query,
  onQuery,
  leading,
  placeholder = "Filter files",
}: {
  title: string;
  query: string;
  onQuery: (value: string) => void;
  leading?: ReactNode;
  placeholder?: string;
}) {
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
          placeholder={placeholder}
          aria-label={`Filter ${title}`}
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
}: {
  nodes: SearchNode[];
  toPath: (relative: string) => string;
  selected: string | null;
  onOpenFile: (path: string) => void;
  onLoadDir?: (path: string) => Promise<FileTreeEntry[] | null>;
  menu?: (entry: FileTreeEntry) => ReactNode;
  decorate?: (node: SearchNode, entry: FileTreeEntry) => FileTreeEntry;
}) {
  const [seen, setSeen] = useState(nodes);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(generation);
  const [tree, setTree] = useState(() => buildFilteredTree(nodes, toPath, decorate));
  if (seen !== nodes) {
    setSeen(nodes);
    setGeneration((current) => current + 1);
    setTree(buildFilteredTree(nodes, toPath, decorate));
  }
  useEffect(() => {
    generationRef.current = generation;
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
    if (!tree.entries[path] && onLoadDir) {
      const token = generation;
      const children = await onLoadDir(path);
      if (token !== generationRef.current || !children) return;
      setTree((current) => {
        const open = new Set(current.open);
        open.add(path);
        return { entries: { ...current.entries, [path]: children }, open };
      });
      return;
    }
    setTree((current) => {
      const open = new Set(current.open);
      open.add(path);
      return { ...current, open };
    });
  }

  if (nodes.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No matching files.</p>;
  }

  return (
    <>
      <FileTree
        dir={toPath("")}
        depth={0}
        entries={tree.entries}
        open={tree.open}
        selected={selected}
        onToggle={(path) => void toggle(path)}
        onOpenFile={onOpenFile}
        menu={menu}
      />
    </>
  );
}
