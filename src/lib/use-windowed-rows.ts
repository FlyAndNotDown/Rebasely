import { useLayoutEffect, useMemo, useState } from "react";

export interface WindowedRows {
  viewportRef: (node: HTMLDivElement | null) => void;
  viewport: HTMLDivElement | null;
  start: number;
  end: number;
  before: number;
  after: number;
}

/**
 * Renders only the rows near the viewport. Pass a row count and a fixed height,
 * or an array of per-row heights when rows wrap. Pass `viewportRef` to the
 * scrolling element, render `items.slice(start, end)`, and pad with `before`
 * and `after` pixels so the scroll height stays the same.
 */
export function useWindowedRows(
  countOrHeights: number | number[],
  rowHeightOrOverscan = 20,
  overscan = 16,
  fallbackHeight = 1200,
): WindowedRows {
  const variable = Array.isArray(countOrHeights);
  const heights = variable ? countOrHeights : null;
  const count = variable ? countOrHeights.length : countOrHeights;
  const rowHeight = variable ? 1 : rowHeightOrOverscan;
  const extra = variable ? rowHeightOrOverscan : overscan;
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const prefix = useMemo(() => prefixSums(heights), [heights]);

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
  const height = view.height || fallbackHeight;
  if (prefix) {
    const startIndex = lastAtOrBefore(prefix, view.top);
    const endIndex = firstAtOrAfter(prefix, view.top + height);
    const start = Math.max(0, startIndex - extra);
    const end = Math.min(count, endIndex + extra);
    return {
      viewportRef: setNode,
      viewport: node,
      start,
      end,
      before: prefix[start] ?? 0,
      after: (prefix[count] ?? 0) - (prefix[end] ?? 0),
    };
  }

  const start = Math.min(count, Math.max(0, Math.floor(view.top / rowHeight) - extra));
  const end = Math.min(count, Math.ceil((view.top + height) / rowHeight) + extra);
  return {
    viewportRef: setNode,
    viewport: node,
    start,
    end,
    before: start * rowHeight,
    after: (count - end) * rowHeight,
  };
}

function prefixSums(heights: number[] | null) {
  if (!heights) return null;
  const sums = new Array<number>(heights.length + 1);
  sums[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    sums[index + 1] = sums[index] + heights[index];
  }
  return sums;
}

/** Last index whose prefix is <= target. Prefix[0] is 0. */
function lastAtOrBefore(prefix: number[], target: number) {
  let lo = 0;
  let hi = prefix.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefix[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** First index whose prefix is >= target. */
function firstAtOrAfter(prefix: number[], target: number) {
  let lo = 0;
  let hi = prefix.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefix[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
