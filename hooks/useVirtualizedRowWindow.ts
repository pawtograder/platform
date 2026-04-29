"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type UseVirtualizedRowWindowOptions = {
  estimatedRowHeight?: number;
  overscan?: number;
  minRowsForVirtualization?: number;
};

/**
 * Lightweight row-window virtualization hook for large tabular datasets.
 * It keeps DOM node count bounded while preserving existing table rendering logic.
 */
export function useVirtualizedRowWindow<TRow>(
  rows: TRow[],
  { estimatedRowHeight = 64, overscan = 8, minRowsForVirtualization = 80 }: UseVirtualizedRowWindowOptions = {}
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight);
    };
    updateViewportHeight();

    const resizeObserver = new ResizeObserver(updateViewportHeight);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const shouldVirtualize = rows.length >= minRowsForVirtualization;

  const { startIndex, endIndex, paddingTop, paddingBottom, visibleRows } = useMemo(() => {
    if (!shouldVirtualize || viewportHeight <= 0) {
      return {
        startIndex: 0,
        endIndex: rows.length,
        paddingTop: 0,
        paddingBottom: 0,
        visibleRows: rows
      };
    }

    const start = Math.max(Math.floor(scrollTop / estimatedRowHeight) - overscan, 0);
    const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / estimatedRowHeight) + overscan);

    return {
      startIndex: start,
      endIndex: end,
      paddingTop: start * estimatedRowHeight,
      paddingBottom: Math.max(0, (rows.length - end) * estimatedRowHeight),
      visibleRows: rows.slice(start, end)
    };
  }, [estimatedRowHeight, overscan, rows, scrollTop, shouldVirtualize, viewportHeight]);

  return {
    containerRef,
    onScroll,
    shouldVirtualize,
    startIndex,
    endIndex,
    paddingTop,
    paddingBottom,
    visibleRows
  };
}
