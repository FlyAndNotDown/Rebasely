import { useLayoutEffect, useState } from "react";

/**
 * Renders only the rows near the viewport of a fixed-row-height list. Pass
 * `viewportRef` to the scrolling element (e.g. `ScrollArea`'s `viewportRef`),
 * render `items.slice(start, end)`, and pad above and below with `before` and
 * `after` pixels so the scroll height stays the same.
 */
export function useWindowedRows(count: number, rowHeight: number, overscan = 16) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const top = node.scrollTop;
      const height = node.clientHeight;
      setView((current) =>
        current.top === top && current.height === height ? current : { top, height },
      );
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [node]);

  // Before the first measurement, render roughly one screen instead of nothing.
  const height = view.height || 1200;
  const start = Math.min(count, Math.max(0, Math.floor(view.top / rowHeight) - overscan));
  const end = Math.min(count, Math.ceil((view.top + height) / rowHeight) + overscan);
  return {
    viewportRef: setNode,
    viewport: node,
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
  };
}
