"use client";

import { useEffect, useRef, useState } from "react";

/** Measure container width and return label width (50% of container, for chart Y-axis) */
export function useContainerWidth(): { ref: React.RefObject<HTMLDivElement | null>; labelWidth: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [labelWidth, setLabelWidth] = useState(200);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setLabelWidth(Math.max(200, Math.round(w * 0.5)));
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  return { ref, labelWidth };
}
