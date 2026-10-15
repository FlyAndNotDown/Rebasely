import type { ReactNode } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export interface FileTreeEntry {
  path: string;
  name: string;
  dir: boolean;
  ignored?: boolean;
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
        const row = (
            <button
              type="button"
              title={item.ignored ? "Ignored" : item.name}
              className={cn(
                "flex h-7 w-full items-center gap-1 pr-2 text-left text-xs hover:bg-muted/70",
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
                  <FolderOpenIcon className="size-3.5 shrink-0" />
                ) : (
                  <FolderIcon className="size-3.5 shrink-0" />
                )
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
              {trailing ? trailing(item) : null}
            </button>
        );
        return (
          <div key={item.path}>
            {menu && !item.dir ? (
              <ContextMenu>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                {menu(item)}
              </ContextMenu>
            ) : (
              row
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
