"use client";

import { Box } from "@chakra-ui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ChartDimensions = {
  width: number;
  height: number;
};

const DIMENSION_EPSILON = 1;

function isVisualTestMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-visual-tests");
}

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
  const visualTestMeasuredRef = useRef(false);

  const commitDimensions = (width: number, measuredHeight: number) => {
    const next = { width, height: measuredHeight };
    const prev = dimensionsRef.current;
    if (prev && dimensionsMatch(prev, next)) {
      return;
    }
    dimensionsRef.current = next;
    setDimensions(next);
  };

  const measure = () => {
    if (measuringRef.current) return;

    const host = hostRef.current;
    if (!host) return;

    if (isVisualTestMode()) {
      if (visualTestMeasuredRef.current) return;
    }

    measuringRef.current = true;
    const observer = observerRef.current;
    observer?.disconnect();

    const rect = host.getBoundingClientRect();
    const width = Math.max(0, Math.floor(rect.width));
    const measuredHeight = Math.max(height, Math.floor(rect.height));

    measuringRef.current = false;

    if (width <= 0) {
      if (observer && host && !isVisualTestMode()) {
        observer.observe(host);
      }
      return;
    }

    commitDimensions(width, measuredHeight);

    if (isVisualTestMode()) {
      visualTestMeasuredRef.current = true;
      return;
    }

    observer?.observe(host);
  };

  const scheduleMeasure = () => {
    if (measureFrameRef.current != null) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    visualTestMeasuredRef.current = false;

    if (isVisualTestMode()) {
      scheduleMeasure();
      return () => {
        if (measureFrameRef.current != null) {
          cancelAnimationFrame(measureFrameRef.current);
          measureFrameRef.current = null;
        }
      };
    }

    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });
    observerRef.current = observer;
    observer.observe(host);
    scheduleMeasure();

    return () => {
      observer.disconnect();
      observerRef.current = null;
      if (measureFrameRef.current != null) {
        cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [height]);

  // Visual tests defer measurement to rAF; ensure a follow-up pass if the first
  // frame had zero width (e.g. host not yet in layout) without attaching observers.
  useEffect(() => {
    if (!isVisualTestMode() || visualTestMeasuredRef.current) return;
    scheduleMeasure();
    return () => {
      if (measureFrameRef.current != null) {
        cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [height]);

  return (
    <Box ref={hostRef} w="100%" h={`${height}px`} data-survey-chart-host="">
      {dimensions ? children(dimensions) : null}
    </Box>
  );
}
