"use client";

import { useEffect, useRef, useState } from "react";
import { useBreakpointValue } from "@chakra-ui/react";

/**
 * Returns whether the viewport is at the `lg` breakpoint or wider, but is resilient to the
 * degenerate ultra-narrow viewport widths (e.g. 1px) that browsers/Playwright transiently emulate
 * while capturing a full-page screenshot.
 *
 * The grading layouts swap between a resizable desktop "IDE shell" and a stacked mobile layout based
 * on this flag. A naive `useBreakpointValue({ base: false, lg: true })` re-evaluates to `false` during
 * a full-page screenshot's transient width collapse, which unmounts and remounts the entire editor
 * subtree — destroying any open line-action popup / in-progress annotation form. Holding the last
 * value seen at a *credible* viewport width keeps the editor mounted across that artifact while still
 * responding to genuine resizes (no real device is narrower than {@link MIN_CREDIBLE_WIDTH}px).
 */
const MIN_CREDIBLE_WIDTH = 200;

export function useStableDesktop(): boolean {
  const raw = useBreakpointValue({ base: false, lg: true }, { ssr: false });
  const [stable, setStable] = useState<boolean>(raw ?? false);
  const lastCredible = useRef<boolean>(raw ?? false);

  useEffect(() => {
    if (raw === undefined) return;
    // Ignore the transient sub-200px widths that only occur during screenshot capture; those would
    // otherwise flip us to the mobile layout and remount the editor.
    if (typeof window !== "undefined" && window.innerWidth < MIN_CREDIBLE_WIDTH) return;
    lastCredible.current = raw;
    setStable(raw);
  }, [raw]);

  return stable;
}
