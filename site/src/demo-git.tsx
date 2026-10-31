import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArchiveIcon, ChevronDownIcon, CircleDotIcon, FolderTreeIcon, GitBranchIcon, HistoryIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { allHunkIds, demoCommits, demoFiles, type DemoCommit, type DemoFile } from "./demo-data";
import { DemoFileRow, DiffPane, EmptyPane, PaneHeader } from "./demo-shared";

type GitView = "changes" | "history" | "stash" | "files";
type FileScope = "unstaged" | "staged";
const views = [
  { value: "changes", label: "Changes", icon: CircleDotIcon },
  { value: "history", label: "History", icon: HistoryIcon },
  { value: "stash", label: "Stash", icon: ArchiveIcon },
  { value: "files", label: "Files", icon: FolderTreeIcon },
] as const;

export function GitDemo({ onNotice }: { onNotice: (notice: string) => void }) {
  const [view, setView] = useState<GitView>("changes");
  const [remaining, setRemaining] = useState(() => new Set(allHunkIds));
  const [staged, setStaged] = useState<Set<string>>(() => new Set());
  const [fileId, setFileId] = useState("navigation");
  const [scope, setScope] = useState<FileScope>("unstaged");
  const [message, setMessage] = useState("Refine workspace navigation");
  const [commits, setCommits] = useState(demoCommits);
  const [historyHash, setHistoryHash] = useState(demoCommits[0].hash);
  const [stashApplied, setStashApplied] = useState(false);
  const viewButtons = useRef<Partial<Record<GitView, HTMLButtonElement | null>>>({});
  const pendingViewFocus = useRef(false);
  const pendingFileFocus = useRef(false);
  const focusSelectedFile = useCallback((node: HTMLButtonElement | null) => {
    if (node && pendingFileFocus.current) {
      pendingFileFocus.current = false;
      node.focus();
    }
  }, []);
  useLayoutEffect(() => {
    if (pendingViewFocus.current) {
      pendingViewFocus.current = false;
      viewButtons.current[view]?.focus();
    }
  }, [view]);
  const file = demoFiles.find((item) => item.id === fileId) ?? demoFiles[0];
  const changed = demoFiles.filter((item) => item.hunks.some((hunk) => remaining.has(hunk.id)));
  const stagedFiles = changed.filter((item) => item.hunks.some((hunk) => staged.has(hunk.id)));
  const unstagedFiles = changed.filter((item) => item.hunks.some((hunk) => remaining.has(hunk.id) && !staged.has(hunk.id)));
  const hunks = file.hunks.filter((hunk) => remaining.has(hunk.id) && staged.has(hunk.id) === (scope === "staged"));

  function selectFile(next: DemoFile, nextScope: FileScope) {
    setFileId(next.id);
    setScope(nextScope);
  }

  function moveHunks(ids: string[], nextScope: FileScope) {
    setStaged((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (nextScope === "staged") next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setScope(nextScope);
    onNotice(nextScope === "staged" ? "Staged in the demo. Review the staged diff or create a sample commit." : "Moved back to Unstaged in the demo.");
  }

  function commit() {
    if (!staged.size || !message.trim()) return;
    const next: DemoCommit = { hash: (0xd31a720 + commits.length - demoCommits.length).toString(16), summary: message.trim(), ref: "main", time: "Just now", fileIds: stagedFiles.map((item) => item.id), hunkIds: [...staged] };
    setCommits((current) => [next, ...current.map((item) => ({ ...item, ref: item.ref === "main" ? undefined : item.ref }))]);
    setRemaining((current) => new Set([...current].filter((id) => !staged.has(id))));
    setStaged(new Set());
    setHistoryHash(next.hash);
    pendingViewFocus.current = true;
    setView("history");
    onNotice("Sample commit created. Select it in History to review exactly what you staged.");
  }

  return (
    <>
      <div className="demo-toolbar"><span className="demo-branch"><GitBranchIcon />main</span><span className="demo-toolbar-detail">atlas</span><span className="demo-toolbar-right">Git repository</span></div>
      <Tabs orientation="vertical" value={view} onValueChange={(value) => setView(value as GitView)} className="demo-view-tabs">
        <div className="demo-sidebar">
          <TabsList aria-label="Git demo views">{views.map(({ value, label, icon: Icon }) => <HoverTip key={value} label={label} side="right"><TabsTrigger ref={(node) => { viewButtons.current[value] = node; }} value={value} aria-label={label}><Icon /></TabsTrigger></HoverTip>)}</TabsList>
          <span className="demo-settings" aria-hidden="true"><SettingsIcon /></span>
        </div>
        <TabsContent value="changes" className="demo-view-panel">
          <div className="demo-split">
            <div className="demo-file-pane">
              <PaneHeader><span>{changed.length} changed {changed.length === 1 ? "file" : "files"}</span><span className="demo-muted">Changes</span></PaneHeader>
              <ScrollArea className="demo-file-scroll" gutter={false}>
                {([['unstaged', unstagedFiles], ['staged', stagedFiles]] as const).map(([group, items]) => <section className="demo-file-group" key={group} aria-label={group === "staged" ? "Staged files" : "Unstaged files"}>
                  <h4><ChevronDownIcon />{group === "staged" ? "Staged" : "Unstaged"}<span>{items.length}</span></h4>
                  {items.map((item) => <DemoFileRow key={item.id} file={item} active={fileId === item.id && scope === group} selectRef={fileId === item.id && scope === group ? focusSelectedFile : undefined} onSelect={() => selectFile(item, group)} action={group === "staged" ? "unstage" : "stage"} actionLabel={`${group === "staged" ? "Unstage" : "Stage"} ${item.path}`} onAction={() => { pendingFileFocus.current = true; setFileId(item.id); moveHunks(item.hunks.filter((hunk) => remaining.has(hunk.id)).map((hunk) => hunk.id), group === "staged" ? "unstaged" : "staged"); }} />)}
                  {!items.length ? <p className="demo-group-empty">{group === "staged" ? "Stage a file or hunk." : "No unstaged changes."}</p> : null}
                </section>)}
              </ScrollArea>
              <form className="demo-compose" onSubmit={(event) => { event.preventDefault(); commit(); }}>
                <label className="sr-only" htmlFor="demo-commit-message">Sample commit message</label>
                <Textarea id="demo-commit-message" value={message} maxLength={120} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" rows={2} />
                <div><span>{stagedFiles.length} staged</span><Button type="submit" size="sm" disabled={!staged.size || !message.trim()}>Commit</Button></div>
              </form>
            </div>
            {changed.length ? <DiffPane file={file} hunks={hunks} actionLabel={scope === "staged" ? "Unstage hunk" : "Stage hunk"} onHunkAction={(hunk) => moveHunks([hunk.id], scope === "staged" ? "unstaged" : "staged")} /> : <EmptyPane title="Working tree clean." detail="Your sample commit is in History."><Button size="sm" variant="outline" onClick={() => { pendingViewFocus.current = true; setView("history"); }}>View history</Button></EmptyPane>}
          </div>
        </TabsContent>
        <TabsContent value="history" className="demo-view-panel"><GitHistory commits={commits} selectedHash={historyHash} onSelect={setHistoryHash} /></TabsContent>
        <TabsContent value="stash" className="demo-view-panel">
          <div className="demo-split">
            <div className="demo-file-pane"><PaneHeader>Stash</PaneHeader>{stashApplied ? <EmptyPane title="Stash applied." detail="The sample files are back in Changes."><Button size="sm" variant="outline" onClick={() => { pendingViewFocus.current = true; setView("changes"); }}>View changes</Button></EmptyPane> : <><div className="demo-stash-summary"><ArchiveIcon /><strong>Workspace navigation</strong><span>On main · 1 hour ago</span><Button size="sm" variant="outline" onClick={() => { setRemaining(new Set(allHunkIds)); setStaged(new Set()); setStashApplied(true); setFileId("navigation"); setScope("unstaged"); pendingViewFocus.current = true; setView("changes"); onNotice("Sample stash applied. Review the restored files in Changes."); }}>Apply stash</Button></div><DemoFileRow file={demoFiles[0]} active onSelect={() => setFileId("navigation")} /></>}</div>
            <DiffPane file={demoFiles[0]} />
          </div>
        </TabsContent>
        <TabsContent value="files" className="demo-view-panel"><FilesDemo /></TabsContent>
      </Tabs>
    </>
  );
}

function GitHistory({ commits, selectedHash, onSelect }: { commits: DemoCommit[]; selectedHash: string; onSelect: (hash: string) => void }) {
  const [query, setQuery] = useState("");
  const [pickedFile, setPickedFile] = useState("navigation");
  const filtered = commits.filter((commit) => `${commit.summary} ${commit.hash} ${commit.ref ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = filtered.find((commit) => commit.hash === selectedHash) ?? filtered[0];
  const files = demoFiles.filter((file) => selected?.fileIds.includes(file.id));
  const file = files.find((item) => item.id === pickedFile) ?? files[0];
  return (
    <div className="demo-history">
      <aside className="demo-branches" aria-label="Illustrative branches"><PaneHeader>Branches</PaneHeader><p>Local</p><div className="selected"><GitBranchIcon />main<span>HEAD</span></div><div><GitBranchIcon />feature/search</div><p>Remotes</p><div><ChevronDownIcon />origin</div><div><GitBranchIcon />main</div><p>Tags</p><div>◇ <span>v1.0.0</span></div></aside>
      <div className="demo-history-main">
        <PaneHeader><span>History</span><Input aria-label="Filter sample commits" placeholder="Filter commits" value={query} onChange={(event) => setQuery(event.target.value)} className="demo-history-filter" /></PaneHeader>
        <ScrollArea className="demo-history-list" gutter={false}>
          {filtered.map((commit) => <button type="button" key={commit.hash} className={cn("demo-commit-row", selected?.hash === commit.hash && "selected")} aria-pressed={selected?.hash === commit.hash} onClick={() => onSelect(commit.hash)}><span className={cn("demo-graph", commit.graph)} aria-hidden="true"><i /><b /></span><span className="demo-commit-summary">{commit.ref ? <span className="demo-ref">{commit.ref}</span> : null}{commit.summary}</span><code>{commit.hash}</code><time>{commit.time}</time></button>)}
          {!filtered.length ? <p className="demo-no-results">No matching commits.</p> : null}
        </ScrollArea>
        {selected && file ? <div className="demo-history-detail"><div className="demo-history-files"><PaneHeader>Changed files <span>{files.length}</span></PaneHeader>{files.map((item) => <DemoFileRow key={item.id} file={item} active={file.id === item.id} onSelect={() => setPickedFile(item.id)} />)}<div className="demo-commit-meta"><strong>{selected.summary}</strong><span>{selected.hash} · Alice · {selected.time}</span></div></div><div className="demo-history-diff"><div className="demo-mobile-file-picker"><label htmlFor="demo-history-file">Changed file</label><select id="demo-history-file" value={file.id} onChange={(event) => setPickedFile(event.target.value)}>{files.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}</select></div><DiffPane file={file} hunks={selected.hunkIds ? file.hunks.filter((hunk) => selected.hunkIds?.includes(hunk.id)) : file.hunks} /></div></div> : <EmptyPane title="No matching commits." detail="Try another summary, branch, or hash." />}
      </div>
    </div>
  );
}

export function FilesDemo({ perforce = false }: { perforce?: boolean }) {
  const [fileId, setFileId] = useState("navigation");
  const file = demoFiles.find((item) => item.id === fileId) ?? demoFiles[0];
  return <div className="demo-split"><div className="demo-file-pane"><PaneHeader>{perforce ? "Workspace" : "Files"}</PaneHeader><div className="demo-tree-folder"><ChevronDownIcon /><FolderTreeIcon />{perforce ? "//depot/main/src" : "src"}</div>{demoFiles.map((item) => <DemoFileRow key={item.id} file={item} active={file.id === item.id} onSelect={() => setFileId(item.id)} />)}</div><section className="demo-diff"><PaneHeader><span className="demo-path">{file.path}</span><span className="demo-language">TypeScript</span></PaneHeader><ScrollArea className="demo-code-scroll" gutter={false} aria-label={`Sample contents of ${file.path}`} tabIndex={0}><div className="demo-code">{file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.after !== undefined).map((line, index) => <div className="demo-code-row" key={index}><span className="demo-line-number">{line.newNumber}</span><code>{line.after}</code></div>)}</div></ScrollArea></section></div>;
}
