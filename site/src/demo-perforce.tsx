import { useTranslation } from "react-i18next";
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
  { value: "pending", label: "demo.pending", icon: CircleDotIcon },
  { value: "history", label: "demo.history", icon: HistoryIcon },
  { value: "workspace", label: "demo.workspace", icon: FolderTreeIcon },
] as const;

export function PerforceDemo({ onNotice }: { onNotice: (notice: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<P4View>("pending");
  const [fileId, setFileId] = useState("navigation");
  const [shelf, setShelf] = useState(false);
  const [hasShelf, setHasShelf] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [description, setDescription] = useState(t("demo.sampleMessage"));
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
  const history = submitted ? [{ id: "42", summary: submittedDescription, fileId: "navigation", time: "demo.justNow" }, ...p4Changes] : p4Changes;
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
    onNotice(t("demo.submittedNotice"));
  }

  return (
    <>
      <div className="demo-toolbar"><span className="demo-branch"><FolderTreeIcon />studio-main</span><span className="demo-toolbar-detail">//depot/main</span><span className="demo-toolbar-right">{t("demo.p4Workspace")}</span></div>
      <Tabs orientation="vertical" value={view} onValueChange={(value) => setView(value as P4View)} className="demo-view-tabs">
        <div className="demo-sidebar"><TabsList aria-label={t("demo.p4Views")}>{views.map(({ value, label, icon: Icon }) => <HoverTip key={value} label={t(label)} side="right"><TabsTrigger ref={value === "history" ? historyButton : undefined} value={value} aria-label={t(label)}><Icon /></TabsTrigger></HoverTip>)}</TabsList><span className="demo-settings" aria-hidden="true"><SettingsIcon /></span></div>
        <TabsContent value="pending" className="demo-view-panel">
          {submitted ? <EmptyPane title={t("demo.noPending")} detail={t("demo.changeInHistory")}><Button size="sm" variant="outline" onClick={() => { pendingViewFocus.current = true; setView("history"); }}>{t("demo.viewChangelist")}</Button></EmptyPane> : <div className="demo-split">
            <div className="demo-file-pane"><PaneHeader><span>{t("demo.pending")}</span><span className="demo-muted">{t("demo.oneChangelist")}</span></PaneHeader>
              <ScrollArea className="demo-file-scroll" gutter={false}>
                <div className="demo-changelist-title"><ChevronDownIcon /><strong>42</strong><span>{description.trim() || t("demo.noDescription")}</span></div>
                <section className="demo-file-group" aria-label={t("demo.openedFiles")}><h4><ChevronDownIcon />{t("demo.opened")}<span>2</span></h4>{files.map((item) => <DemoFileRow key={item.id} file={item} active={fileId === item.id && !shelf} onSelect={() => { setFileId(item.id); setShelf(false); }} />)}</section>
                {hasShelf ? <section className="demo-file-group" aria-label={t("demo.shelvedFiles")}><h4><ArchiveIcon />{t("demo.shelved")}<span>2</span></h4>{files.map((item) => <DemoFileRow key={item.id} file={item} active={fileId === item.id && shelf} onSelect={() => { setFileId(item.id); setShelf(true); }} />)}</section> : null}
              </ScrollArea>
              <form className="demo-compose" onSubmit={(event) => { event.preventDefault(); submit(); }}><label className="sr-only" htmlFor="demo-changelist-description">{t("demo.description")}</label><Textarea id="demo-changelist-description" rows={2} maxLength={120} placeholder={t("demo.descriptionPlaceholder")} value={description} onChange={(event) => setDescription(event.target.value)} /><div><Button size="sm" variant="outline" onClick={() => { setHasShelf(true); setShelf(true); onNotice(hasShelf ? t("demo.shelfUpdated") : t("demo.shelvedNotice")); }}>{hasShelf ? <CheckIcon /> : <ArchiveIcon />}{hasShelf ? t("demo.updateShelf") : t("demo.shelve")}</Button><Button size="sm" type="submit" disabled={!description.trim()}>{t("demo.submit")}</Button></div></form>
            </div>
            <div className="demo-pending-diff">{shelf ? <div className="demo-shelf-label"><ArchiveIcon />{t("demo.shelvedVersion")}</div> : null}<DiffPane file={file} /></div>
          </div>}
        </TabsContent>
        <TabsContent value="history" className="demo-view-panel"><div className="demo-p4-history"><div className="demo-file-pane"><PaneHeader>{t("demo.history")}</PaneHeader><div className="demo-p4-filter"><Input aria-label={t("demo.filterChangesLabel")} placeholder={t("demo.filterChanges")} value={query} onChange={(event) => setQuery(event.target.value)} /></div><ScrollArea className="demo-file-scroll" gutter={false}>{filtered.map((change) => <button type="button" key={change.id} className={cn("demo-change-row", selected?.id === change.id && "selected")} aria-pressed={selected?.id === change.id} onClick={() => setHistoryId(change.id)}><span className="demo-change-id">{change.id}</span><strong>{change.summary}</strong><span>Alice · {t(change.time)}</span></button>)}{!filtered.length ? <p className="demo-no-results">{t("demo.noChangelists")}</p> : null}</ScrollArea></div>{selected && historyFile ? <div className="demo-pending-diff"><div className="demo-submitted-heading"><strong>{t("demo.changeNumber", { number: selected.id })}</strong><span>{selected.summary}</span></div><div className="demo-history-file-picker"><label htmlFor="demo-p4-history-file">{t("demo.changedFile")}</label><select id="demo-p4-history-file" value={historyFile.id} onChange={(event) => setHistoryFileId(event.target.value)}>{historyFiles.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}</select></div><DiffPane file={historyFile} /></div> : <EmptyPane title={t("demo.noChangelists")} detail={t("demo.tryChange")} />}</div></TabsContent>
        <TabsContent value="workspace" className="demo-view-panel"><FilesDemo perforce /></TabsContent>
      </Tabs>
    </>
  );
}
