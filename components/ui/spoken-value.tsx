"use client";

import { chakra, VisuallyHidden } from "@chakra-ui/react";
import * as React from "react";

/**
 * Pairs a screen-reader-only phrasing of a value with a purely visual rendering
 * of the same value (WCAG 1.1.1/1.3.1): screen readers announce `spoken` while
 * the children stay hidden from them, so compact notation like "7/10" or "✅"
 * can be voiced as "7 of 10 points" or "Passed" without being read twice.
 *
 * Renders inline (VisuallyHidden span + aria-hidden span), so it can sit inside
 * Text, table cells, and flex rows without affecting layout.
 */
export function SpokenValue({ spoken, children }: { spoken: string; children: React.ReactNode }) {
  return (
    <>
      <VisuallyHidden>{spoken}</VisuallyHidden>
      <chakra.span aria-hidden="true">{children}</chakra.span>
    </>
  );
}
