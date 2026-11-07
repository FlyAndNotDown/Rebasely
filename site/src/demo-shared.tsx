import { useTranslation } from "react-i18next";
import { useState, type ReactNode, type Ref } from "react";
import { CheckIcon, Columns2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { cn } from "@/lib/utils";
import type { DemoFile, DemoHunk, DemoLine } from "./demo-data";

export function PaneHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("demo-pane-header", className)}>{children}</div>;
}

export function DemoFileRow({ file, active, onSelect, action, actionLabel, onAction, selectRef, directory = true, perforce = false }: {
  file: DemoFile;
  active?: boolean;
  onSelect: () => void;
  action?: "stage" | "unstage";
  actionLabel?: string;
  onAction?: () => void;
  selectRef?: Ref<HTMLButtonElement>;
  directory?: boolean;
  perforce?: boolean;
}) {
  return (
    <div className={cn("demo-file-row", active && "selected")}>
      <HoverTip label={file.path}><button ref={selectRef} type="button" className="demo-file-select" onClick={onSelect} aria-pressed={active}>
        {perforce ? <FileStatusIcon status={file.status === "A" ? "add" : "edit"} /> : <span className={file.status === "A" ? "demo-added" : "demo-modified"}>{file.status}</span>}
        <span className="demo-file-name">{file.path.split("/").at(-1)}</span>
        {directory && !perforce ? <span className="demo-file-directory">{file.path.slice(0, file.path.lastIndexOf("/"))}</span> : null}
      </button></HoverTip>
      {onAction ? (
        <HoverTip label={actionLabel}>
          <Button variant="ghost" size="icon-xs" className="demo-file-action" aria-label={actionLabel} onClick={onAction}>
            {action === "unstage" ? <MinusIcon /> : <PlusIcon />}
          </Button>
        </HoverTip>
      ) : null}
    </div>
  );
}

export function DiffPane({ file, hunks = file.hunks, actionLabel, onHunkAction, emptyAction, scopeLabel }: {
  file: DemoFile;
  hunks?: DemoHunk[];
  actionLabel?: string;
  onHunkAction?: (hunk: DemoHunk) => void;
  emptyAction?: ReactNode;
  scopeLabel?: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  return (
    <section className="demo-diff" aria-label={t("demo.diff", { path: file.path })}>
      <PaneHeader className="demo-diff-header">
        <span className="demo-path" title={file.path}>{file.path}</span>
        <div className="demo-diff-actions" role="group" aria-label={t("demo.diffLayout")}>
          <span className="demo-diff-scope">{scopeLabel ?? (actionLabel ? t("demo.workingChanges") : t("demo.readOnly"))}</span>
          <HoverTip label={t("demo.split")}>
            <Button size="icon-xs" variant={mode === "split" ? "secondary" : "ghost"} aria-label={t("demo.split")} aria-pressed={mode === "split"} onClick={() => setMode(mode === "split" ? "unified" : "split")}><Columns2Icon /></Button>
          </HoverTip>
        </div>
      </PaneHeader>
      {hunks.length ? (
        <ScrollArea className="demo-code-scroll" gutter={false} viewportClassName="demo-code-viewport focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" viewportProps={{ role: "region", "aria-label": t("demo.diffLines"), tabIndex: 0 }}>
          <div className={cn("demo-code", mode === "split" && "demo-code-split")}>
            {hunks.map((hunk) => (
              <div key={hunk.id} className="demo-hunk">
                <div className="demo-hunk-header"><code>{hunk.header}</code>{onHunkAction ? <Button size="xs" variant="outline" onClick={() => onHunkAction(hunk)}>{actionLabel}</Button> : null}</div>
                {hunk.lines.map((line, index) => mode === "split" ? <SplitLine key={index} line={line} /> : <UnifiedLine key={index} line={line} />)}
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : <EmptyPane title={t("demo.noChanges")} detail={t("demo.selectOther")}>{emptyAction}</EmptyPane>}
    </section>
  );
}

function UnifiedLine({ line }: { line: DemoLine }) {
  if (line.before === line.after) return <CodeLine number={line.newNumber} text={line.after} kind="context" />;
  return <>{line.before !== undefined ? <CodeLine number={line.oldNumber} text={line.before} kind="removed" /> : null}{line.after !== undefined ? <CodeLine number={line.newNumber} text={line.after} kind="added" /> : null}</>;
}

function SplitLine({ line }: { line: DemoLine }) {
  const same = line.before === line.after;
  return <div className="demo-split-line"><CodeLine number={line.oldNumber} text={line.before} kind={same ? "context" : "removed"} /><CodeLine number={line.newNumber} text={line.after} kind={same ? "context" : "added"} /></div>;
}

function CodeLine({ number, text, kind }: { number?: number; text?: string; kind: "context" | "added" | "removed" }) {
  return <div className={cn("demo-code-row", text !== undefined && `demo-line-${kind}`)}><span className="demo-line-number">{number}</span><span className="demo-line-sign" aria-hidden="true">{text === undefined || kind === "context" ? " " : kind === "added" ? "+" : "−"}</span><code>{text ?? " "}</code></div>;
}

export function EmptyPane({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <div className="demo-empty"><CheckIcon /><strong>{title}</strong>{detail ? <p>{detail}</p> : null}{children}</div>;
}
