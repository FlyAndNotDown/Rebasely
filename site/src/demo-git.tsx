import { useTranslation } from "react-i18next";
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
  { value: "changes", label: "demo.changes", icon: CircleDotIcon },
  { value: "history", label: "demo.history", icon: HistoryIcon },
  { value: "stash", label: "demo.stash", icon: ArchiveIcon },
  { value: "files", label: "demo.files", icon: FolderTreeIcon },
] as const;

export function GitDemo({ onNotice }: { onNotice: (notice: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<GitView>("changes");
  const [remaining, setRemaining] = useState(() => new Set(allHunkIds));
  const [staged, setStaged] = useState<Set<string>>(() => new Set());
  const [fileId, setFileId] = useState("navigation");
  const [scope, setScope] = useState<FileScope>("unstaged");
  const [message, setMessage] = useState(t("demo.sampleMessage"));
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
    onNotice(nextScope === "staged" ? t("demo.stagedNotice") : t("demo.unstagedNotice"));
  }

  function commit() {
    if (!staged.size || !message.trim()) return;
    const next: DemoCommit = { hash: (0xd31a720 + commits.length - demoCommits.length).toString(16), summary: message.trim(), ref: "main", time: "demo.justNow", fileIds: stagedFiles.map((item) => item.id), hunkIds: [...staged] };
    setCommits((current) => [next, ...current.map((item) => ({ ...item, ref: item.ref === "main" ? undefined : item.ref }))]);
    setRemaining((current) => new Set([...current].filter((id) => !staged.has(id))));
    setStaged(new Set());
    setHistoryHash(next.hash);
    pendingViewFocus.current = true;
    setView("history");
    onNotice(t("demo.commitNotice"));
  }

  return (
    <>
      <div className="demo-toolbar"><span className="demo-branch"><GitBranchIcon />main</span><span className="demo-toolbar-detail">atlas</span><span className="demo-toolbar-right">{t("demo.gitRepository")}</span></div>
      <Tabs orientation="vertical" value={view} onValueChange={(value) => setView(value as GitView)} className="demo-view-tabs">
        <div className="demo-sidebar">
          <TabsList aria-label={t("demo.gitViews")}>{views.map(({ value, label, icon: Icon }) => <HoverTip key={value} label={t(label)} side="right"><TabsTrigger ref={(node) => { viewButtons.current[value] = node; }} value={value} aria-label={t(label)}><Icon /></TabsTrigger></HoverTip>)}</TabsList>
          <span className="demo-settings" aria-hidden="true"><SettingsIcon /></span>
        </div>
        <TabsContent value="changes" className="demo-view-panel">
          <div className="demo-split">
            <div className="demo-file-pane">
              <PaneHeader><span>{t("demo.changedFiles", { count: changed.length })}</span><span className="demo-muted">{t("demo.changes")}</span></PaneHeader>
              <ScrollArea className="demo-file-scroll" gutter={false}>
                {([['unstaged', unstagedFiles], ['staged', stagedFiles]] as const).map(([group, items]) => <section className="demo-file-group" key={group} aria-label={group === "staged" ? t("demo.stagedFiles") : t("demo.unstagedFiles")}>
                  <h4><ChevronDownIcon />{group === "staged" ? t("demo.staged") : t("demo.unstaged")}<span>{items.length}</span></h4>
                  {items.map((item) => <DemoFileRow key={item.id} file={item} active={fileId === item.id && scope === group} selectRef={fileId === item.id && scope === group ? focusSelectedFile : undefined} onSelect={() => selectFile(item, group)} action={group === "staged" ? "unstage" : "stage"} actionLabel={t(group === "staged" ? "demo.unstageFile" : "demo.stageFile", { path: item.path })} onAction={() => { pendingFileFocus.current = true; setFileId(item.id); moveHunks(item.hunks.filter((hunk) => remaining.has(hunk.id)).map((hunk) => hunk.id), group === "staged" ? "unstaged" : "staged"); }} />)}
                  {!items.length ? <p className="demo-group-empty">{group === "staged" ? t("demo.stagePrompt") : t("demo.noUnstaged")}</p> : null}
                </section>)}
              </ScrollArea>
              <form className="demo-compose" onSubmit={(event) => { event.preventDefault(); commit(); }}>
                <label className="sr-only" htmlFor="demo-commit-message">{t("demo.message")}</label>
                <Textarea id="demo-commit-message" value={message} maxLength={120} onChange={(event) => setMessage(event.target.value)} placeholder={t("demo.messagePlaceholder")} rows={2} />
                <div><span>{t("demo.stagedCount", { count: stagedFiles.length })}</span><Button type="submit" size="sm" disabled={!staged.size || !message.trim()}>{t("demo.commit")}</Button></div>
              </form>
            </div>
            {changed.length ? <DiffPane file={file} hunks={hunks} actionLabel={scope === "staged" ? t("demo.unstageHunk") : t("demo.stageHunk")} onHunkAction={(hunk) => moveHunks([hunk.id], scope === "staged" ? "unstaged" : "staged")} /> : <EmptyPane title={t("demo.clean")} detail={t("demo.commitInHistory")}><Button size="sm" variant="outline" onClick={() => { pendingViewFocus.current = true; setView("history"); }}>{t("demo.viewHistory")}</Button></EmptyPane>}
          </div>
        </TabsContent>
        <TabsContent value="history" className="demo-view-panel"><GitHistory commits={commits} selectedHash={historyHash} onSelect={setHistoryHash} /></TabsContent>
        <TabsContent value="stash" className="demo-view-panel">
          <div className="demo-split">
            <div className="demo-file-pane"><PaneHeader>{t("demo.stash")}</PaneHeader>{stashApplied ? <EmptyPane title={t("demo.stashApplied")} detail={t("demo.stashDetail")}><Button size="sm" variant="outline" onClick={() => { pendingViewFocus.current = true; setView("changes"); }}>{t("demo.viewChanges")}</Button></EmptyPane> : <><div className="demo-stash-summary"><ArchiveIcon /><strong>{t("demo.sampleStash")}</strong><span>{t("demo.stashTime")}</span><Button size="sm" variant="outline" onClick={() => { setRemaining(new Set(allHunkIds)); setStaged(new Set()); setStashApplied(true); setFileId("navigation"); setScope("unstaged"); pendingViewFocus.current = true; setView("changes"); onNotice(t("demo.stashNotice")); }}>{t("demo.applyStash")}</Button></div><DemoFileRow file={demoFiles[0]} active onSelect={() => setFileId("navigation")} /></>}</div>
            <DiffPane file={demoFiles[0]} />
          </div>
        </TabsContent>
        <TabsContent value="files" className="demo-view-panel"><FilesDemo /></TabsContent>
      </Tabs>
    </>
  );
}

function GitHistory({ commits, selectedHash, onSelect }: { commits: DemoCommit[]; selectedHash: string; onSelect: (hash: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [pickedFile, setPickedFile] = useState("navigation");
  const filtered = commits.filter((commit) => `${commit.summary} ${commit.hash} ${commit.ref ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = filtered.find((commit) => commit.hash === selectedHash) ?? filtered[0];
  const files = demoFiles.filter((file) => selected?.fileIds.includes(file.id));
  const file = files.find((item) => item.id === pickedFile) ?? files[0];
  return (
    <div className="demo-history">
      <aside className="demo-branches" aria-label={t("demo.illustrativeBranches")}><PaneHeader>{t("demo.branches")}</PaneHeader><p>{t("demo.local")}</p><div className="selected"><GitBranchIcon />main<span>HEAD</span></div><div><GitBranchIcon />feature/search</div><p>{t("demo.remotes")}</p><div><ChevronDownIcon />origin</div><div><GitBranchIcon />main</div><p>{t("demo.tags")}</p><div>◇ <span>v1.0.0</span></div></aside>
      <div className="demo-history-main">
        <PaneHeader><span>{t("demo.history")}</span><Input aria-label={t("demo.filterCommitsLabel")} placeholder={t("demo.filterCommits")} value={query} onChange={(event) => setQuery(event.target.value)} className="demo-history-filter" /></PaneHeader>
        <ScrollArea className="demo-history-list" gutter={false}>
          {filtered.map((commit) => <button type="button" key={commit.hash} className={cn("demo-commit-row", selected?.hash === commit.hash && "selected")} aria-pressed={selected?.hash === commit.hash} onClick={() => onSelect(commit.hash)}><span className={cn("demo-graph", commit.graph)} aria-hidden="true"><i /><b /></span><span className="demo-commit-summary">{commit.ref ? <span className="demo-ref">{commit.ref}</span> : null}{commit.summary}</span><code>{commit.hash}</code><time>{t(commit.time)}</time></button>)}
          {!filtered.length ? <p className="demo-no-results">{t("demo.noCommits")}</p> : null}
        </ScrollArea>
        {selected && file ? <div className="demo-history-detail"><div className="demo-history-files"><PaneHeader>{t("demo.changedFilesLabel")} <span>{files.length}</span></PaneHeader>{files.map((item) => <DemoFileRow key={item.id} file={item} active={file.id === item.id} onSelect={() => setPickedFile(item.id)} />)}<div className="demo-commit-meta"><strong>{selected.summary}</strong><span>{selected.hash} · Alice · {t(selected.time)}</span></div></div><div className="demo-history-diff"><div className="demo-mobile-file-picker"><label htmlFor="demo-history-file">{t("demo.changedFile")}</label><select id="demo-history-file" value={file.id} onChange={(event) => setPickedFile(event.target.value)}>{files.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}</select></div><DiffPane file={file} hunks={selected.hunkIds ? file.hunks.filter((hunk) => selected.hunkIds?.includes(hunk.id)) : file.hunks} /></div></div> : <EmptyPane title={t("demo.noCommits")} detail={t("demo.tryCommit")} />}
      </div>
    </div>
  );
}

export function FilesDemo({ perforce = false }: { perforce?: boolean }) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState("navigation");
  const file = demoFiles.find((item) => item.id === fileId) ?? demoFiles[0];
  return <div className="demo-split"><div className="demo-file-pane"><PaneHeader>{perforce ? t("demo.workspace") : t("demo.files")}</PaneHeader><div className="demo-tree-folder"><ChevronDownIcon /><FolderTreeIcon />{perforce ? "//depot/main/src" : "src"}</div>{demoFiles.map((item) => <DemoFileRow key={item.id} file={item} active={file.id === item.id} onSelect={() => setFileId(item.id)} />)}</div><section className="demo-diff"><PaneHeader><span className="demo-path">{file.path}</span><span className="demo-language">TypeScript</span></PaneHeader><ScrollArea className="demo-code-scroll" gutter={false} aria-label={t("demo.contents", { path: file.path })} tabIndex={0}><div className="demo-code">{file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.after !== undefined).map((line, index) => <div className="demo-code-row" key={index}><span className="demo-line-number">{line.newNumber}</span><code>{line.after}</code></div>)}</div></ScrollArea></section></div>;
}
