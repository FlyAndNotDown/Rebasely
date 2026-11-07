import { memo, useMemo, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLinkIcon } from "lucide-react";
import { releaseNoteLink } from "@/lib/release-note-links";

const allowedElements = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del",
  "code", "pre", "blockquote", "hr", "br", "a", "img", "table", "thead", "tbody", "tr", "th", "td",
  "input", "sup", "section",
];

export const ReleaseNotes = memo(function ReleaseNotes({ notes, label, onOpenLink }: {
  notes: string;
  label: string;
  onOpenLink: (url: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    h1: ({ children }) => <h4 className="mt-5 mb-2 text-base leading-6 font-semibold tracking-tight">{children}</h4>,
    h2: ({ children }) => <h5 className="mt-4 mb-2 text-sm leading-5 font-semibold">{children}</h5>,
    h3: ({ children }) => <h6 className="mt-3 mb-1.5 text-[13px] font-semibold">{children}</h6>,
    h4: ({ children }) => <h6 className="mt-3 mb-1.5 text-xs font-medium text-muted-foreground">{children}</h6>,
    h5: ({ children }) => <h6 className="mt-3 mb-1.5 text-xs font-medium text-muted-foreground">{children}</h6>,
    h6: ({ children }) => <h6 className="mt-3 mb-1.5 text-xs font-medium text-muted-foreground">{children}</h6>,
    p: ({ children }) => <p className="my-2">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
    ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>,
    li: ({ children }) => <li className="[&>p]:my-1">{children}</li>,
    code: ({ children }) => <code className="rounded border bg-background/60 px-1 py-px font-mono text-xs">{children}</code>,
    pre: ({ children }) => <pre tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-md border bg-background/60 p-3 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0">{children}</pre>,
    blockquote: ({ children }) => <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
    hr: () => <hr className="my-4" />,
    img: ({ alt }) => alt ? <span className="text-muted-foreground">{alt}</span> : null,
    input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled tabIndex={-1} className="mr-1.5 size-3 accent-primary" />,
    table: ({ children }) => <div role="region" aria-label={label} tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><table className="w-full border-collapse text-left [&_tbody_tr:last-child_td]:border-b-0">{children}</table></div>,
    th: ({ children, style }) => <th style={style} className="border-b bg-muted px-3 py-2 font-medium">{children}</th>,
    td: ({ children, style }) => <td style={style} className="border-b px-3 py-2">{children}</td>,
    a: ({ children, href }) => {
      const url = href;
      if (!url) return <span>{children}</span>;
      const open = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (event.type !== "auxclick" || event.button === 1) onOpenLink(url);
      };
      return <a href={url} title={url} onClick={open} onAuxClick={open} className="rounded-sm underline decoration-foreground/30 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50">{children}<ExternalLinkIcon aria-hidden="true" className="ml-0.5 inline size-3 align-baseline text-muted-foreground" /></a>;
    },
  }), [label, onOpenLink]);

  return <div className="min-w-0 py-3 pr-3 text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"><Markdown remarkPlugins={[remarkGfm]} allowedElements={allowedElements} skipHtml urlTransform={(url, key) => key === "href" ? releaseNoteLink(url) : undefined} components={components}>{notes}</Markdown></div>;
});

export default ReleaseNotes;
