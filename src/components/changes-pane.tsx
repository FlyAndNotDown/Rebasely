import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  AppWindowIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  CopyIcon,
  FileIcon,
  FilePenIcon,
  FileSearchIcon,
  FileXIcon,
  FilesIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitMergeIcon,
  HistoryIcon,
  ListIcon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  changeRows,
  ignoreExtensionPattern,
  ignorePathPattern,
  rangeBetween,
  type ChangeRow,
  type ChangeSection,
} from "@/lib/change-tree";
import { fileKindClass, fileKindLabel } from "@/lib/file-kind";
import { fileName, parentPath } from "@/lib/format";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { FileStatus, WorkspaceSnapshot } from "@/types/git";

const ROW_HEIGHT = 28;
const SECTIONS: ChangeSection[] = ["unstaged", "staged"];
const SECTION_TITLE: Record<ChangeSection, string> = { unstaged: "Changes", staged: "Staged" };

type ListRow =
  | { kind: "section"; section: ChangeSection; count: number; open: boolean }
  | { kind: "empty"; section: ChangeSection }
  | ChangeRow;

type ChangeListSelection = { section: ChangeSection; paths: ReadonlySet<string>; anchor: string | null };

const CONTINUE_LABEL: Record<string, string> = {
  merge: "Continue merge",
  rebase: "Continue rebase",
  "cherry-pick": "Continue cherry-pick",
  revert: "Continue revert",
};

function headCommitMessage(snapshot: WorkspaceSnapshot) {
  const head = snapshot.headCommit;
  if (!head) return "";
  return head.body ? `${head.summary}\n\n${head.body}` : head.summary;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function rowKey(row: ListRow) {
  if (row.kind === "file") return `${row.section}:file:${row.file.path}`;
  if (row.kind === "dir") return `${row.section}:dir:${row.path}`;
  return `${row.section}:${row.kind}`;
}

export function ChangesPane() {
  const {
    snapshot,
    changeSelection,
    prefs,
    selectChange,
    stage,
    unstage,
    discard,
    commit,
    pushRemote,
    operationContinue,
    stashSave,
    ignorePaths,
    showFile,
    openRepoFile,
    revealRepoFile,
    openInEditor,
    openDifftool,
    runMergetool,
    updatePrefs,
    commitDraft,
  } = useGitPick([
    "snapshot",
    "commitDraft",
    "changeSelection",
    "prefs",
    "selectChange",
    "stage",
    "unstage",
    "discard",
    "commit",
    "pushRemote",
    "operationContinue",
    "stashSave",
    "ignorePaths",
    "showFile",
    "openRepoFile",
    "revealRepoFile",
    "openInEditor",
    "openDifftool",
    "runMergetool",
    "updatePrefs",
  ]);
  const operation = snapshot?.repo.operation ?? null;
  const preparedMessage = operation?.message ?? "";
  const [message, setMessage] = useState(preparedMessage);
  const [shownPrepared, setShownPrepared] = useState(preparedMessage);
  if (preparedMessage !== shownPrepared) {
    setShownPrepared(preparedMessage);
    if (!message.trim() || message === shownPrepared) setMessage(preparedMessage);
  }
  const [shownDraft, setShownDraft] = useState(commitDraft?.nonce ?? 0);
  if (commitDraft && commitDraft.nonce !== shownDraft) {
    setShownDraft(commitDraft.nonce);
    if (!message.trim()) setMessage(commitDraft.text);
  }
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<string[] | null>(null);
  const [stashTarget, setStashTarget] = useState<string[] | null>(null);
  const [sectionOpen, setSectionOpen] = useState<Record<ChangeSection, boolean>>({
    unstaged: true,
    staged: true,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ChangeListSelection>({
    section: "unstaged",
    paths: new Set(),
    anchor: null,
  });
  const tree = prefs.changesTree;
  const staged = snapshot?.status.staged;
  const unstaged = snapshot?.status.unstaged;
  const files = useMemo(
    () => ({ unstaged: unstaged ?? [], staged: staged ?? [] }),
    [staged, unstaged],
  );
  const conflicted = files.unstaged.some((file) => file.kind === "conflicted");

  const sectionRows = useMemo(
    () => ({
      unstaged: changeRows("unstaged", files.unstaged, tree, collapsed),
      staged: changeRows("staged", files.staged, tree, collapsed),
    }),
    [collapsed, files, tree],
  );
  const rows = useMemo(() => {
    const list: ListRow[] = [];
    for (const section of SECTIONS) {
      const open = sectionOpen[section];
      list.push({ kind: "section", section, count: files[section].length, open });
      if (!open) continue;
      if (files[section].length === 0) list.push({ kind: "empty", section });
      for (const row of sectionRows[section]) list.push(row);
    }
    return list;
  }, [files, sectionOpen, sectionRows]);
  // Visible files of each section in display order, for range selection and arrow keys.
  const order = useMemo(() => {
    const visible = (section: ChangeSection) =>
      sectionOpen[section]
        ? sectionRows[section].flatMap((row) => (row.kind === "file" ? [row.file.path] : []))
        : [];
    return { unstaged: visible("unstaged"), staged: visible("staged") };
  }, [sectionOpen, sectionRows]);
  const byPath = useMemo(
    () => ({
      unstaged: new Map(files.unstaged.map((file) => [file.path, file])),
      staged: new Map(files.staged.map((file) => [file.path, file])),
    }),
    [files],
  );
  const windowed = useWindowedRows(rows.length, ROW_HEIGHT);

  const activeSection: ChangeSection | null = changeSelection
    ? changeSelection.staged
      ? "staged"
      : "unstaged"
    : null;
  const isActive = (section: ChangeSection, path: string) =>
    activeSection === section && changeSelection?.path === path;
  const isSelected = (section: ChangeSection, path: string) =>
    (selection.section === section && selection.paths.has(path)) || isActive(section, path);
  const selectedIn = (section: ChangeSection) =>
    selection.section === section
      ? [...selection.paths].filter((path) => byPath[section].has(path))
      : [];
  /** The files a row action applies to: the selection when the row is part of it. */
  const targetsFor = (section: ChangeSection, path: string) => {
    const selected = selectedIn(section);
    return selected.length > 1 && selected.includes(path) ? selected : [path];
  };

  const canAmend = Boolean(snapshot?.headCommit) && !operation;
  const canCommitAndPush =
    !operation && !committing && message.trim().length > 0 && files.staged.length > 0;
  const canOpenCommitMenu = canCommitAndPush || canAmend;
  const canCommit = operation
    ? !committing && !conflicted
    : !committing && message.trim().length > 0 && (amend ? canAmend : files.staged.length > 0);
  const primaryLabel = operation
    ? (CONTINUE_LABEL[operation.kind] ?? "Continue")
    : amend
      ? "Amend"
      : "Commit";

  function focusFile(section: ChangeSection, path: string) {
    void selectChange(path, section === "staged");
    const index = rows.findIndex(
      (row) => row.kind === "file" && row.section === section && row.file.path === path,
    );
    const viewport = windowed.viewport;
    if (index < 0 || !viewport) return;
    const top = index * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTo({ top });
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: top + ROW_HEIGHT - viewport.clientHeight });
    }
  }

  function selectOnly(section: ChangeSection, path: string) {
    setSelection({ section, paths: new Set([path]), anchor: path });
    focusFile(section, path);
  }

  function clickFile(event: MouseEvent, section: ChangeSection, path: string) {
    const sameSection = selection.section === section;
    if (event.shiftKey) {
      const anchor = sameSection ? selection.anchor : null;
      setSelection({
        section,
        paths: new Set(rangeBetween(order[section], anchor, path)),
        anchor: anchor ?? path,
      });
      focusFile(section, path);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && sameSection) {
      const next = new Set(selection.paths);
      if (activeSection === section && changeSelection) next.add(changeSelection.path);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      setSelection({ section, paths: next, anchor: path });
      if (next.has(path)) focusFile(section, path);
      return;
    }
    selectOnly(section, path);
  }

  function primaryAction(section: ChangeSection, paths: string[]) {
    if (paths.length === 0) return;
    if (section === "staged") void unstage(paths);
    else void stage(paths);
  }

  function toggleFolder(section: ChangeSection, path: string) {
    const key = `${section}:${path}`;
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const combined = SECTIONS.flatMap((section) =>
      order[section].map((path) => ({ section, path })),
    );
    if (combined.length === 0) return;
    const current = changeSelection
      ? combined.findIndex(
          (item) => item.section === activeSection && item.path === changeSelection.path,
        )
      : -1;
    const section = current >= 0 ? combined[current].section : combined[0].section;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        combined[Math.min(combined.length - 1, Math.max(0, current < 0 ? 0 : current + step))];
      if (event.shiftKey && next.section === selection.section) {
        const anchor = selection.anchor ?? changeSelection?.path ?? next.path;
        setSelection({
          section: next.section,
          paths: new Set(rangeBetween(order[next.section], anchor, next.path)),
          anchor,
        });
        focusFile(next.section, next.path);
      } else {
        selectOnly(next.section, next.path);
      }
      return;
    }
    if (current < 0) return;
    const targets = targetsFor(section, combined[current].path);
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      primaryAction(section, targets);
    } else if ((event.key === "Delete" || event.key === "Backspace") && section === "unstaged") {
      event.preventDefault();
      setDiscardTarget(targets);
    } else if (event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setSelection({ section, paths: new Set(order[section]), anchor: order[section][0] ?? null });
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  async function runCommit(next: string, nextAmend: boolean) {
    setCommitting(true);
    try {
      const ok = await commit(next, nextAmend);
      if (ok) {
        setMessage((current) => (current === next ? "" : current));
        setAmend(false);
      }
      return ok;
    } finally {
      setCommitting(false);
    }
  }

  async function runContinue(next: string) {
    setCommitting(true);
    try {
      const edited = next.trim() && next.trim() !== preparedMessage.trim() ? next : undefined;
      if (await operationContinue(edited)) {
        setMessage((current) => (current === next ? "" : current));
      }
    } finally {
      setCommitting(false);
    }
  }

  function submitCommit() {
    if (!canCommit) return;
    if (operation) void runContinue(message);
    else void runCommit(message, amend);
  }

  function submitCommitAndPush() {
    if (!canCommitAndPush) return;
    void (async () => {
      if (await runCommit(message, false)) {
        await pushRemote();
      }
    })();
  }

  function toggleAmend(next: boolean) {
    setAmend(next);
    if (next && snapshot && !message.trim()) {
      setMessage(headCommitMessage(snapshot));
    }
  }

  function fileMenu(section: ChangeSection, file: FileStatus) {
    const targets = targetsFor(section, file.path);
    const many = targets.length > 1;
    const untracked = targets.every((path) => byPath[section].get(path)?.kind === "untracked");
    const tracked = file.kind !== "untracked" && file.kind !== "added";
    const extension = ignoreExtensionPattern(file.path);
    const folder = parentPath(file.path);
    return (
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onClick={() => primaryAction(section, targets)}>
          {section === "staged" ? <MinusIcon /> : <PlusIcon />}
          {section === "staged" ? "Unstage" : "Stage"}
          {many ? ` ${plural(targets.length, "file")}` : ""}
        </ContextMenuItem>
        {section === "unstaged" ? (
          <>
            <ContextMenuItem onClick={() => setStashTarget(targets)}>
              <ArchiveIcon />
              Stash {many ? plural(targets.length, "file") : "changes"}…
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => setDiscardTarget(targets)}>
              <Trash2Icon />
              Discard {many ? plural(targets.length, "file") : "changes"}…
            </ContextMenuItem>
          </>
        ) : null}
        {section === "unstaged" && untracked ? (
          <>
            <ContextMenuSeparator />
            {many ? (
              <ContextMenuItem onClick={() => void ignorePaths(targets.map((path) => ignorePathPattern(path)))}>
                <FileXIcon />
                Ignore {plural(targets.length, "file")}
              </ContextMenuItem>
            ) : (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <FileXIcon />
                  Add to .gitignore
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem onClick={() => void ignorePaths([ignorePathPattern(file.path)])}>
                    <FileIcon />
                    This file
                  </ContextMenuItem>
                  {extension ? (
                    <ContextMenuItem onClick={() => void ignorePaths([extension])}>
                      <FilesIcon />
                      All {extension} files
                    </ContextMenuItem>
                  ) : null}
                  {folder ? (
                    <ContextMenuItem onClick={() => void ignorePaths([ignorePathPattern(folder, true)])}>
                      <FolderIcon />
                      Folder {folder}/
                    </ContextMenuItem>
                  ) : null}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
          </>
        ) : null}
        {many ? null : (
          <>
            <ContextMenuSeparator />
            {file.kind !== "deleted" ? (
              <>
                <ContextMenuItem onClick={() => void openInEditor(file.path)}>
                  <FilePenIcon />
                  Open in editor
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void openRepoFile(file.path)}>
                  <AppWindowIcon />
                  Open with default app
                </ContextMenuItem>
              </>
            ) : null}
            {file.kind !== "untracked" && file.kind !== "conflicted" ? (
              <ContextMenuItem
                onClick={() =>
                  void openDifftool({ kind: "workdir", path: file.path, staged: section === "staged" })
                }
              >
                <Columns2Icon />
                Open in diff tool
              </ContextMenuItem>
            ) : null}
            {file.kind === "conflicted" ? (
              <ContextMenuItem onClick={() => void runMergetool(file.path)}>
                <GitMergeIcon />
                Open in merge tool
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => void revealRepoFile(file.kind === "deleted" ? folder : file.path)}>
              <FolderOpenIcon />
              Reveal in file manager
            </ContextMenuItem>
            {tracked ? (
              <>
                <ContextMenuItem onClick={() => showFile(file.path, "history")}>
                  <HistoryIcon />
                  File history
                </ContextMenuItem>
                {file.kind !== "deleted" ? (
                  <ContextMenuItem onClick={() => showFile(file.path, "browse")}>
                    <FileSearchIcon />
                    Blame
                  </ContextMenuItem>
                ) : null}
              </>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void copyText(file.path)}>
              <CopyIcon />
              Copy relative path
            </ContextMenuItem>
            {snapshot ? (
              <ContextMenuItem
                onClick={() => void copyText(`${snapshot.repo.path.replace(/[\\/]+$/, "")}/${file.path}`)}
              >
                <CopyIcon />
                Copy full path
              </ContextMenuItem>
            ) : null}
          </>
        )}
      </ContextMenuContent>
    );
  }

  function folderMenu(row: Extract<ChangeRow, { kind: "dir" }>) {
    const allUntracked = row.paths.every((path) => byPath[row.section].get(path)?.kind === "untracked");
    return (
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onClick={() => primaryAction(row.section, row.paths)}>
          {row.section === "staged" ? <MinusIcon /> : <PlusIcon />}
          {row.section === "staged" ? "Unstage folder" : "Stage folder"}
        </ContextMenuItem>
        {row.section === "unstaged" ? (
          <>
            <ContextMenuItem onClick={() => setStashTarget(row.paths)}>
              <ArchiveIcon />
              Stash folder…
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => setDiscardTarget(row.paths)}>
              <Trash2Icon />
              Discard folder…
            </ContextMenuItem>
            {allUntracked ? (
              <ContextMenuItem onClick={() => void ignorePaths([ignorePathPattern(row.path, true)])}>
                <FileXIcon />
                Add folder to .gitignore
              </ContextMenuItem>
            ) : null}
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void revealRepoFile(row.path)}>
          <FolderOpenIcon />
          Reveal in file manager
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyText(row.path)}>
          <CopyIcon />
          Copy relative path
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }

  function renderRow(row: ListRow) {
    if (row.kind === "section") {
      const count = row.count;
      const label = row.section === "staged" ? "Unstage all" : "Stage all";
      return (
        <div className="flex h-7 items-center gap-1 px-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/70"
            onClick={() =>
              setSectionOpen((current) => ({ ...current, [row.section]: !current[row.section] }))
            }
            aria-expanded={row.open}
          >
            <ChevronDownIcon
              className={cn("size-3.5 text-muted-foreground transition-transform", !row.open && "-rotate-90")}
            />
            <span className="text-xs font-medium">{SECTION_TITLE[row.section]}</span>
            <span className="tabular-nums text-xs text-muted-foreground">{count}</span>
          </button>
          {count > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => primaryAction(row.section, files[row.section].map((file) => file.path))}
            >
              {label}
            </Button>
          ) : null}
        </div>
      );
    }
    if (row.kind === "empty") {
      return (
        <p className="flex h-7 items-center px-4 text-xs text-muted-foreground">
          {row.section === "staged" ? "No staged files" : "Working tree is clean"}
        </p>
      );
    }
    if (row.kind === "dir") {
      return (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className="group mx-2 flex h-7 items-center gap-1 rounded-md pr-1 text-sm hover:bg-muted/70"
              style={{ paddingLeft: 6 + row.depth * 14 }}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                onClick={() => toggleFolder(row.section, row.path)}
                aria-expanded={row.open}
              >
                <ChevronRightIcon
                  className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.open && "rotate-90")}
                />
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{row.label}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{row.paths.length}</span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => primaryAction(row.section, row.paths)}
                aria-label={row.section === "staged" ? `Unstage ${row.path}` : `Stage ${row.path}`}
              >
                {row.section === "staged" ? <MinusIcon /> : <PlusIcon />}
              </Button>
            </div>
          </ContextMenuTrigger>
          {folderMenu(row)}
        </ContextMenu>
      );
    }
    const { file, section } = row;
    const directory = parentPath(file.path);
    const selected = isSelected(section, file.path);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group mx-2 flex h-7 items-center gap-1 rounded-md pr-1 text-sm hover:bg-muted/70",
              selected && "bg-muted",
            )}
            style={{ paddingLeft: 6 + row.depth * 14 + (tree ? 18 : 0) }}
            onContextMenu={() => {
              if (!selected) selectOnly(section, file.path);
            }}
          >
            <HoverTip label={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            <button
              type="button"
              tabIndex={-1}
              className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
              onClick={(event) => clickFile(event, section, file.path)}
            >
              <span className={cn("w-3 shrink-0 font-mono text-[11px] font-medium", fileKindClass(file.kind))}>
                {fileKindLabel(file.kind)}
              </span>
              <span className="shrink-0 truncate">{fileName(file.path)}</span>
              {!tree && directory ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{directory}</span>
              ) : null}
            </button>
            </HoverTip>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => primaryAction(section, targetsFor(section, file.path))}
              aria-label={section === "staged" ? "Unstage" : "Stage"}
            >
              {section === "staged" ? <MinusIcon /> : <PlusIcon />}
            </Button>
          </div>
        </ContextMenuTrigger>
        {fileMenu(section, file)}
      </ContextMenu>
    );
  }

  const totalSelected = selectedIn(selection.section).length;
  const stashUntracked = (stashTarget ?? []).some(
    (path) => byPath.unstaged.get(path)?.kind === "untracked",
  );

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {totalSelected > 1
            ? `${totalSelected} selected`
            : plural(new Set([...files.unstaged, ...files.staged].map((file) => file.path)).size, "changed file")}
        </span>
        <SegmentedControl
          label="Changed files layout"
          dense
          value={tree ? "tree" : "list"}
          onChange={(value) => {
            const next = value === "tree";
            if (next !== tree) void updatePrefs({ ...prefs, changesTree: next });
          }}
          options={[
            { value: "list", label: <ListIcon />, tip: "Show as list" },
            { value: "tree", label: <FolderTreeIcon />, tip: "Group by folder" },
          ]}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={windowed.viewportRef}>
        <div
          role="listbox"
          aria-multiselectable
          aria-label="Changed files"
          tabIndex={0}
          className="py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
          onKeyDown={onListKeyDown}
        >
          <div style={{ height: windowed.before }} />
          {rows.slice(windowed.start, windowed.end).map((row) => (
            <div key={rowKey(row)}>{renderRow(row)}</div>
          ))}
          <div style={{ height: windowed.after }} />
        </div>
      </ScrollArea>

      <form
        className="shrink-0 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitCommit();
        }}
      >
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          className="min-h-20 resize-none"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              submitCommit();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!files.unstaged.length}
            onClick={() => setDiscardTarget(files.unstaged.map((file) => file.path))}
          >
            <Undo2Icon data-icon="inline-start" />
            Discard all
          </Button>
          <div className="inline-flex overflow-hidden rounded-lg">
            <HoverTip label={operation && conflicted ? "Resolve every conflict first" : undefined}>
              <span className="inline-flex">
                <Button type="submit" disabled={!canCommit} className="rounded-none">
                  {primaryLabel}
                </Button>
              </span>
            </HoverTip>
            {operation ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    disabled={!canOpenCommitMenu}
                    aria-label="Commit options"
                    className="rounded-none border-l border-primary-foreground/20 px-1.5"
                  >
                    <ChevronDownIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-max">
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    disabled={!canCommitAndPush}
                    onClick={submitCommitAndPush}
                  >
                    Commit and push
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem
                    checked={amend}
                    disabled={!canAmend}
                    className="whitespace-nowrap"
                    onCheckedChange={(checked) => toggleAmend(checked === true)}
                  >
                    Amend last commit
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </form>

      <Dialog open={!!discardTarget} onOpenChange={(open) => !open && setDiscardTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {discardTarget && discardTarget.length === 1
                ? `Discard changes to ${fileName(discardTarget[0])}?`
                : `Discard changes to ${plural(discardTarget?.length ?? 0, "file")}?`}
            </DialogTitle>
            <DialogDescription>
              This restores the selected files to HEAD and deletes untracked files. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (discardTarget) void discard(discardTarget);
                setDiscardTarget(null);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!stashTarget} onOpenChange={(open) => !open && setStashTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {stashTarget ? (
            <StashPathsForm
              count={stashTarget.length}
              includesUntracked={stashUntracked}
              onCancel={() => setStashTarget(null)}
              onStash={async (stashMessage) => {
                const ok = await stashSave(stashMessage, stashUntracked, stashTarget);
                if (ok) setStashTarget(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StashPathsForm({
  count,
  includesUntracked,
  onCancel,
  onStash,
}: {
  count: number;
  includesUntracked: boolean;
  onCancel: () => void;
  onStash: (message: string) => Promise<void>;
}) {
  const [stashMessage, setStashMessage] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void onStash(stashMessage.trim()).finally(() => setSaving(false));
      }}
    >
      <DialogHeader>
        <DialogTitle>Stash {plural(count, "file")}</DialogTitle>
        <DialogDescription>
          Saves the changes to these files in a new stash and restores them to HEAD.
          {includesUntracked ? " Untracked files are included." : ""}
        </DialogDescription>
      </DialogHeader>
      <Input
        className="mt-3"
        autoFocus
        placeholder="Stash message (optional)"
        value={stashMessage}
        onChange={(event) => setStashMessage(event.target.value)}
      />
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          Stash
        </Button>
      </DialogFooter>
    </form>
  );
}
