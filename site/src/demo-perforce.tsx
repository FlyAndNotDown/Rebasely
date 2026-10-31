import { useLayoutEffect, useRef, useState } from "react";
import { ArchiveIcon, CheckIcon, ChevronDownIcon, CircleDotIcon, FolderTreeIcon, HistoryIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { demoFiles, p4Changes } from "./demo-data";
import { FilesDemo } from "./demo-git";
import { DemoFileRow, DiffPane, EmptyPane, PaneHeader } from "./demo-shared";

type P4View = "pending" | "history" | "workspace";
const views = [
  { value: "pending", label: "Pending", icon: CircleDotIcon },
  { value: "history", label: "History", icon: HistoryIcon },
  { value: "workspace", label: "Workspace", icon: FolderTreeIcon },
] as const;

export function PerforceDemo({ onNotice }: { onNotice: (notice: string) => void }) {
  const [view, setView] = useState<P4View>("pending");
  const [fileId, setFileId] = useState("navigation");
  const [shelf, setShelf] = useState(false);
  const [hasShelf, setHasShelf] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [description, setDescription] = useState("Refine workspace navigation");
  const [submittedDescription, setSubmittedDescription] = useState("");
  const [historyId, setHistoryId] = useState("41");
  const [query, setQuery] = useState("");
  const [historyFileId, setHistoryFileId] = useState("navigation");
  const historyButton = useRef<HTMLButtonElement | null>(null);
  const pendingViewFocus = useRef(false);
  useLayoutEffect(() => {
    if (pendingViewFocus.current) {
      pendingViewFocus.current = false;
      historyButton.current?.focus();
    }
  }, [view]);
  const files = demoFiles.slice(0, 2);
  const file = files.find((item) => item.id === fileId) ?? files[0];
  const history = submitted ? [{ id: "42", summary: submittedDescription, fileId: "navigation", time: "Just now" }, ...p4Changes] : p4Changes;
  const filtered = history.filter((change) => `${change.id} ${change.summary}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = filtered.find((change) => change.id === historyId) ?? filtered[0];
  const historyFiles = selected?.id === "42" ? files : demoFiles.filter((item) => item.id === selected?.fileId);
  const historyFile = historyFiles.find((item) => item.id === historyFileId) ?? historyFiles[0];

  function submit() {
    if (submitted || !description.trim()) return;
    setSubmitted(true);
    setSubmittedDescription(description.trim());
    setHistoryId("42");
    setHasShelf(false);
    pendingViewFocus.current = true;
    setView("history");
    onNotice("Sample changelist 42 submitted. Its description and diff are now in History.");
  }

  return (
    <>
      <div className="demo-toolbar"><span className="demo-branch"><FolderTreeIcon />studio-main</span><span className="demo-toolbar-detail">//depot/main</span><span className="demo-toolbar-right">Perforce workspace</span></div>
      <Tabs orientation="vertical" value={view} onValueChange={(value) => setView(value as P4View)} className="demo-view-tabs">
        <div className="demo-sidebar"><TabsList aria-label="Perforce demo views">{views.map(({ value, label, icon: Icon }) => <HoverTip key={value} label={label} side="right"><TabsTrigger ref={value === "history" ? historyButton : undefined} value={value} aria-label={label}><Icon /></TabsTrigger></HoverTip>)}</TabsList><span className="demo-settings" aria-hidden="true"><SettingsIcon /></span></div>
        <TabsContent value="pending" className="demo-view-panel">
          {submitted ? <EmptyPane title="No pending files." detail="Your sample changelist is in History."><Button size="sm" variant="outline" onClick={() => { pendingViewFocus.current = true; setView("history"); }}>View changelist</Button></EmptyPane> : <div className="demo-split">
            <div className="demo-file-pane"><PaneHeader><span>Pending</span><span className="demo-muted">1 changelist</span></PaneHeader>
              <ScrollArea className="demo-file-scroll" gutter={false}>
                <div className="demo-changelist-title"><ChevronDownIcon /><strong>42</strong><span>{description.trim() || "No description"}</span></div>
                <section className="demo-file-group" aria-label="Opened files"><h4><ChevronDownIcon />Opened<span>2</span></h4>{files.map((item) => <DemoFileRow key={item.id} file={item} active={fileId === item.id && !shelf} onSelect={() => { setFileId(item.id); setShelf(false); }} />)}</section>
                {hasShelf ? <section className="demo-file-group" aria-label="Shelved files"><h4><ArchiveIcon />Shelved<span>2</span></h4>{files.map((item) => <DemoFileRow key={item.id} file={item} active={fileId === item.id && shelf} onSelect={() => { setFileId(item.id); setShelf(true); }} />)}</section> : null}
              </ScrollArea>
              <form className="demo-compose" onSubmit={(event) => { event.preventDefault(); submit(); }}><label className="sr-only" htmlFor="demo-changelist-description">Sample changelist description</label><Textarea id="demo-changelist-description" rows={2} maxLength={120} placeholder="Changelist description" value={description} onChange={(event) => setDescription(event.target.value)} /><div><Button size="sm" variant="outline" onClick={() => { setHasShelf(true); setShelf(true); onNotice(hasShelf ? "Sample shelf updated." : "Sample files shelved. Select Opened or Shelved files to review either version."); }}>{hasShelf ? <CheckIcon /> : <ArchiveIcon />}{hasShelf ? "Update shelf" : "Shelve"}</Button><Button size="sm" type="submit" disabled={!description.trim()}>Submit changelist</Button></div></form>
            </div>
            <div className="demo-pending-diff">{shelf ? <div className="demo-shelf-label"><ArchiveIcon />Shelved version · Change 42</div> : null}<DiffPane file={file} /></div>
          </div>}
        </TabsContent>
        <TabsContent value="history" className="demo-view-panel"><div className="demo-p4-history"><div className="demo-file-pane"><PaneHeader>History</PaneHeader><div className="demo-p4-filter"><Input aria-label="Filter sample changelists" placeholder="Filter changelists" value={query} onChange={(event) => setQuery(event.target.value)} /></div><ScrollArea className="demo-file-scroll" gutter={false}>{filtered.map((change) => <button type="button" key={change.id} className={cn("demo-change-row", selected?.id === change.id && "selected")} aria-pressed={selected?.id === change.id} onClick={() => setHistoryId(change.id)}><span className="demo-change-id">{change.id}</span><strong>{change.summary}</strong><span>Alice · {change.time}</span></button>)}{!filtered.length ? <p className="demo-no-results">No matching changelists.</p> : null}</ScrollArea></div>{selected && historyFile ? <div className="demo-pending-diff"><div className="demo-submitted-heading"><strong>Change {selected.id}</strong><span>{selected.summary}</span></div><div className="demo-history-file-picker"><label htmlFor="demo-p4-history-file">Changed file</label><select id="demo-p4-history-file" value={historyFile.id} onChange={(event) => setHistoryFileId(event.target.value)}>{historyFiles.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}</select></div><DiffPane file={historyFile} /></div> : <EmptyPane title="No matching changelists." detail="Try another description or number." />}</div></TabsContent>
        <TabsContent value="workspace" className="demo-view-panel"><FilesDemo perforce /></TabsContent>
      </Tabs>
    </>
  );
}
