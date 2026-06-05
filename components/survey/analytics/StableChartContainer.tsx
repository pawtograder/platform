"use client";

import { Box } from "@chakra-ui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isVisualTestMode } from "./visualCaptureUtils";

export type ChartDimensions = {
  width: number;
  height: number;
};

const DIMENSION_EPSILON = 1;

function dimensionsMatch(a: ChartDimensions, b: ChartDimensions): boolean {
  return Math.abs(a.width - b.width) < DIMENSION_EPSILON && Math.abs(a.height - b.height) < DIMENSION_EPSILON;
}

/**
 * Measures a chart host once (visual tests) or via ResizeObserver (normal UI) and
 * passes floored pixel dimensions to children. Recharts' ResponsiveContainer feeds
 * fractional widths into SVG layout, which produces sub-pixel bar drift between
 * Playwright captures — explicit integer width/height avoids that.
 */
export function StableChartContainer({
  height,
  children
}: {
  height: number;
  children: (dimensions: ChartDimensions) => React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<ChartDimensions | null>(null);
  const dimensionsRef = useRef<ChartDimensions | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const measuringRef = useRef(false);
  const visualTestWidthRef = useRef<number | null>(null);

  const commitDimensions = (width: number, measuredHeight: number) => {
    const next = { width, height: measuredHeight };
    const prev = dimensionsRef.current;
    if (prev && dimensionsMatch(prev, next)) {
      return;
    }
    dimensionsRef.current = next;
    setDimensions(next);
    if (isVisualTestMode() && hostRef.current) {
      hostRef.current.setAttribute("data-survey-chart-ready", "");
    }
  };

  const cancelScheduledMeasure = () => {
    if (measureFrameRef.current != null) {
      cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
    }
  };

  const measureFromLayout = (visualTestMode: boolean) => {
    if (measuringRef.current) return;

    const host = hostRef.current;
    if (!host) return;

    if (visualTestMode) {
      const cachedWidth = visualTestWidthRef.current;
      if (cachedWidth != null && cachedWidth > 0) {
        commitDimensions(cachedWidth, height);
        return;
      }
    }

    measuringRef.current = true;
    observerRef.current?.disconnect();

    const width = Math.max(0, Math.floor(host.offsetWidth));
    const measuredHeight = Math.max(height, Math.floor(host.offsetHeight));

    measuringRef.current = false;

    if (width <= 0) {
      if (!visualTestMode && observerRef.current && host) {
        observerRef.current.observe(host);
      }
      return;
    }

    if (visualTestMode) {
      visualTestWidthRef.current = width;
      commitDimensions(width, measuredHeight);
      return;
    }

    commitDimensions(width, measuredHeight);
    observerRef.current?.observe(host);
  };

  const scheduleMeasure = () => {
    if (measureFrameRef.current != null) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measureFromLayout(false);
    });
  };

  useLayoutEffect(() => {
    if (!isVisualTestMode()) return;
    measureFromLayout(true);
  }, [height]);

  useEffect(() => {
    if (isVisualTestMode()) return;

    const host = hostRef.current;
    if (!host) return;

    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });
    observerRef.current = observer;
    observer.observe(host);
    scheduleMeasure();

    return () => {
      observer.disconnect();
      observerRef.current = null;
      cancelScheduledMeasure();
    };
  }, [height]);

  const visualTestMode = isVisualTestMode();

  return (
    <Box
      ref={hostRef}
      w="100%"
      h={`${height}px`}
      data-survey-chart-host=""
      {...(visualTestMode ? { style: { contain: "layout" } } : undefined)}
    >
      {dimensions ? children(dimensions) : null}
    </Box>
  );
}
