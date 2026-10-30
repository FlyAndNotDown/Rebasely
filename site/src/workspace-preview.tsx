import { useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  ArrowDownFromLineIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CodeXmlIcon,
  FileIcon,
  FileInputIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitBranchIcon,
  HistoryIcon,
  MenuIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  SettingsIcon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type PreviewView = "changes" | "history" | "stash" | "files";

const views = [
  { value: "changes", label: "Changes", icon: CircleDotIcon },
  { value: "history", label: "History", icon: HistoryIcon },
  { value: "stash", label: "Stash", icon: ArchiveIcon },
  { value: "files", label: "Files", icon: FolderTreeIcon },
] as const;

export function WorkspacePreview() {
  const [view, setView] = useState<PreviewView>("history");

  return (
    <div className="workspace-preview">
      <div className="preview-titlebar" aria-hidden="true">
        <span className="preview-options"><MenuIcon /></span>
        <span className="preview-repo-tab active"><GitBranchIcon /> atlas <XIcon className="preview-tab-close" /></span>
        <span className="preview-repo-tab secondary"><FolderTreeIcon /> studio <XIcon className="preview-tab-close" /></span>
        <span className="preview-plus"><PlusIcon /></span>
        <div className="preview-window-controls"><span><MinusIcon /></span><span><SquareIcon /></span><span><XIcon /></span></div>
      </div>
      <div className="preview-toolbar" aria-hidden="true">
        <span className="preview-branch">main</span>
        <span className="preview-tool-group">
          {[RefreshCwIcon, ArrowDownFromLineIcon, ArrowDownToLineIcon, ArrowUpFromLineIcon, FileInputIcon].map((Icon, index) => <span key={index}><Icon /></span>)}
          <i /><span><Settings2Icon /></span>
        </span>
        <span className="preview-external-tools"><CodeXmlIcon /><SquareTerminalIcon /><FolderOpenIcon /></span>
      </div>
      <Tabs orientation="vertical" value={view} onValueChange={(value) => setView(value as PreviewView)} className="preview-tabs">
        <div className="preview-nav">
          <TabsList aria-label="Workspace views">
            {views.map(({ value, label, icon: Icon }) => (
              <HoverTip key={value} label={label} side="right">
                <TabsTrigger value={value} aria-label={label}><Icon className="size-4" /></TabsTrigger>
              </HoverTip>
            ))}
          </TabsList>
          <span className="preview-settings" aria-hidden="true"><SettingsIcon /></span>
        </div>
        <TabsContent value="history" className="preview-panel"><HistoryView /></TabsContent>
        <TabsContent value="changes" className="preview-panel"><ChangesView /></TabsContent>
        <TabsContent value="stash" className="preview-panel"><StashView /></TabsContent>
        <TabsContent value="files" className="preview-panel"><FilesView /></TabsContent>
      </Tabs>
      <div className="preview-status"><span><GitBranchIcon className="size-3" /> main</span><span>atlas <span className="preview-status-separator">·</span> {view === "changes" ? "3 changed files" : "Working tree clean"}<CheckIcon className="size-3" /></span></div>
    </div>
  );
}

const commits = [
  { summary: "Refine workspace navigation", hash: "a6f203d", ref: "main", time: "2 min ago", graph: "primary" },
  { summary: "Merge branch 'feature/search'", hash: "9e72bc1", time: "18 min ago", graph: "merge" },
  { summary: "Keep search results in view", hash: "c4d810a", ref: "feature/search", time: "32 min ago", graph: "side" },
  { summary: "Add keyboard navigation", hash: "0b73e6f", time: "1 hour ago", graph: "primary" },
  { summary: "Remember the active workspace", hash: "d891e3a", time: "2 hours ago", graph: "primary" },
  { summary: "Group related changes", hash: "f84b15c", time: "3 hours ago", graph: "primary" },
  { summary: "Create the workspace", hash: "73ca480", time: "Yesterday", graph: "primary" },
];

function HistoryView() {
  return (
    <div className="preview-history">
      <aside className="preview-branches">
        <PaneHeader>Branches</PaneHeader>
        <div className="preview-tree-section">
          <p>Local</p>
          <div className="preview-tree-row selected"><GitBranchIcon /><span>main</span><span className="preview-head">HEAD</span></div>
          <div className="preview-tree-row"><GitBranchIcon /><span>feature/search</span></div>
          <div className="preview-tree-row"><GitBranchIcon /><span>release</span></div>
          <p>Remotes</p>
          <div className="preview-tree-row"><ChevronDownIcon /><span>origin</span></div>
          <div className="preview-tree-row nested"><GitBranchIcon /><span>main</span></div>
          <div className="preview-tree-row nested"><GitBranchIcon /><span>feature/search</span></div>
          <p>Tags</p>
          <div className="preview-tree-row"><span className="preview-tag-symbol">◇</span><span>v1.0.0</span></div>
        </div>
      </aside>
      <div className="preview-history-main">
        <PaneHeader><span>History</span><span className="preview-static-search" aria-hidden="true"><SearchIcon /> Search commits</span></PaneHeader>
        <div className="preview-commit-list" aria-label="Illustrative commit history">
          {commits.map((commit, index) => (
            <div className={cn("preview-commit-row", index === 0 && "selected")} key={commit.hash}>
              <span className={cn("preview-graph-cell", commit.graph)} aria-hidden="true"><i /><b /></span>
              <span className="preview-commit-summary">{commit.ref ? <span className={cn("preview-ref", commit.graph === "side" && "secondary")}>{commit.ref}</span> : null}{commit.summary}</span>
              <span className="preview-commit-hash">{commit.hash}</span>
              <span className="preview-commit-time">{commit.time}</span>
            </div>
          ))}
        </div>
        <div className="preview-commit-detail">
          <div className="preview-changed-files">
            <PaneHeader><span>Changed files</span><span className="preview-count">2</span></PaneHeader>
            <FileRow name="navigation.ts" status="M" selected />
            <FileRow name="navigation.test.ts" status="A" />
            <div className="preview-commit-meta"><strong>Refine workspace navigation</strong><p>a6f203d · Alice · 2 min ago</p></div>
          </div>
          <DiffView />
        </div>
      </div>
    </div>
  );
}

function ChangesView() {
  return (
    <div className="preview-changes">
      <div className="preview-changes-list">
        <PaneHeader><span>Changes</span><span className="preview-count">3</span></PaneHeader>
        <div className="preview-file-section-label"><ChevronDownIcon /> Unstaged <span>2</span></div>
        <FileRow name="navigation.ts" status="M" selected />
        <FileRow name="theme.ts" status="M" />
        <div className="preview-file-section-label"><ChevronDownIcon /> Staged <span>1</span></div>
        <FileRow name="navigation.test.ts" status="A" />
        <div className="preview-commit-compose" aria-hidden="true"><span>Summary</span><div>Refine workspace navigation</div><small>Description (optional)</small><span className="preview-static-primary">Commit 1 file</span></div>
      </div>
      <DiffView detailed />
    </div>
  );
}

function StashView() {
  return (
    <div className="preview-changes">
      <div className="preview-changes-list">
        <PaneHeader>Stash</PaneHeader>
        <div className="preview-stash-item selected"><ArchiveIcon /><span>Workspace navigation<small>On main · 1 hour ago</small></span></div>
        <div className="preview-file-section-label"><ChevronDownIcon /> Files <span>2</span></div>
        <FileRow name="navigation.ts" status="M" selected />
        <FileRow name="navigation.test.ts" status="A" />
      </div>
      <DiffView detailed />
    </div>
  );
}

function FilesView() {
  const lines = [
    "export type View = 'changes' | 'history' | 'files';",
    "",
    "const views: View[] = ['changes', 'history', 'files'];",
    "",
    "export function nextView(",
    "  current: View, direction: 'next' | 'previous',",
    "): View {",
    "  const index = views.indexOf(current);",
    "  const step = direction === 'next' ? 1 : -1;",
    "  return views[(index + step + views.length)",
    "    % views.length];",
    "}",
  ];
  return (
    <div className="preview-changes">
      <div className="preview-changes-list">
        <PaneHeader>Files</PaneHeader>
        <div className="preview-tree-section">
          <div className="preview-tree-row"><ChevronDownIcon /><FolderOpenIcon /><span>src</span></div>
          <div className="preview-tree-row nested"><ChevronRightIcon /><FolderIcon /><span>components</span></div>
          <div className="preview-tree-row nested"><ChevronRightIcon /><FolderIcon /><span>state</span></div>
          <div className="preview-tree-row nested selected"><FileIcon /><span>navigation.ts</span></div>
          <div className="preview-tree-row nested"><FileIcon /><span>theme.ts</span></div>
          <div className="preview-tree-row"><FileIcon /><span>package.json</span></div>
          <div className="preview-tree-row"><FileIcon /><span>README.md</span></div>
        </div>
      </div>
      <div className="preview-code-pane"><PaneHeader><span className="font-mono">src/navigation.ts</span><span className="preview-code-language">TypeScript</span></PaneHeader><div className="preview-code-lines">{lines.map((line, index) => <div className="preview-code-row" key={index}><span className="preview-line-number">{index + 1}</span><code>{line || " "}</code></div>)}</div></div>
    </div>
  );
}

function PaneHeader({ children }: { children: ReactNode }) {
  return <div className="preview-pane-header">{children}</div>;
}

function FileRow({ name, status, selected }: { name: string; status: "A" | "M"; selected?: boolean }) {
  return <div className={cn("preview-file-row", selected && "selected")}><span className={status === "A" ? "preview-file-added" : "preview-file-modified"}>{status}</span><span>{name}</span></div>;
}

const diffLines = [
  { number: "12", type: "context", prefix: " ", code: "export function nextView(" },
  { number: "13", type: "context", prefix: " ", code: "  current: View, direction: Direction" },
  { number: "14", type: "context", prefix: " ", code: "): View {" },
  { number: "15", type: "removed", prefix: "−", code: "  return views[current + 1];" },
  { number: "15", type: "added", prefix: "+", code: "  const index = views.indexOf(current);" },
  { number: "16", type: "added", prefix: "+", code: "  const step = direction === 'next' ? 1 : -1;" },
  { number: "17", type: "added", prefix: "+", code: "  return views[(index + step + views.length)" },
  { number: "18", type: "added", prefix: "+", code: "    % views.length];" },
  { number: "19", type: "context", prefix: " ", code: "}" },
];

function DiffView({ detailed = false }: { detailed?: boolean }) {
  return (
    <div className="preview-code-pane">
      <PaneHeader><span className="preview-diff-path font-mono">src/navigation.ts</span><span className="preview-diff-stat">+4 <b>−1</b></span></PaneHeader>
      {detailed ? <div className="preview-diff-mode" aria-hidden="true"><span>Unified</span><span>Split</span><i /><span>Ignore whitespace</span></div> : null}
      <div className="preview-diff-hunk">@@ −12,5 +12,8 @@</div>
      <div className="preview-code-lines">
        {diffLines.map((line, index) => <div key={index} className={cn("preview-code-row", `preview-line-${line.type}`)}><span className="preview-line-number">{line.number}</span><span className="preview-line-prefix">{line.prefix}</span><code>{line.code}</code></div>)}
      </div>
    </div>
  );
}
