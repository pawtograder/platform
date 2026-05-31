"use client";

import { Box } from "@chakra-ui/react";
import { useLayoutEffect, useRef, useState } from "react";

export type ChartDimensions = {
  width: number;
  height: number;
};

function isVisualTestMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-visual-tests");
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

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width));
      const measuredHeight = Math.max(height, Math.floor(rect.height));
      if (width <= 0) return;

      setDimensions((prev) => {
        if (prev && prev.width === width && prev.height === measuredHeight) {
          return prev;
        }
        return { width, height: measuredHeight };
      });
    };

    measure();

    if (isVisualTestMode()) {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [height]);

  return (
    <Box ref={hostRef} w="100%" h={`${height}px`} data-survey-chart-host="">
      {dimensions ? children(dimensions) : null}
    </Box>
  );
}
