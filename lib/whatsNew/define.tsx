"use client";

import { Box, Stack } from "@chakra-ui/react";
import { type ReactNode, useEffect, useRef } from "react";
import type { CourseFeatureName } from "@/lib/courseFeatures";
import type { WhatsNewAudience, WhatsNewId, WhatsNewPage } from "./ids";

export type WhatsNewStep = {
  title: string;
  body: ReactNode;
};

export type WhatsNewEntry = {
  /** The row key in public.user_whats_new_seen, from WHATS_NEW_IDS. */
  id: WhatsNewId;
  /** The page whose <WhatsNew page="..." /> shows it. */
  page: WhatsNewPage;
  /** Who sees it: course staff (graders and instructors), students, or both. */
  audience: WhatsNewAudience;
  /** When set, it shows only in courses that have this feature turned on. */
  feature?: CourseFeatureName;
  /**
   * Last day (YYYY-MM-DD) it opens on its own. Afterwards the header button still opens it while
   * it is the newest walkthrough for the page.
   */
  showUntil: string;
  /** The intro prompt's heading. */
  title: string;
  /** The intro prompt's text, ending with the question that "Show me" answers. */
  intro: ReactNode;
  steps: WhatsNewStep[];
};

/** Declares a walkthrough. Add the result to WHATS_NEW_ENTRIES in lib/whatsNew/registry.ts. */
export function defineWhatsNew(entry: WhatsNewEntry): WhatsNewEntry {
  return entry;
}

/**
 * Non-interactive frame around a preview of the real UI. aria-hidden hides it from screen
 * readers, and inert takes its buttons out of the tab order, so a keyboard user can't land on a
 * control nobody announces.
 */
export function Preview({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // React 18 has no `inert` prop (same approach as components/bugReport/ReplayPreview.tsx).
  useEffect(() => {
    ref.current?.setAttribute("inert", "");
  }, []);
  return (
    <Box
      ref={ref}
      aria-hidden
      pointerEvents="none"
      userSelect="none"
      borderWidth="1px"
      borderColor="border.muted"
      borderStyle="dashed"
      borderRadius="md"
      bg="bg.subtle"
      p={4}
    >
      {children}
    </Box>
  );
}

/** A step's bullet points. */
export function Points({ items }: { items: ReactNode[] }) {
  return (
    <Stack as="ul" gap={2} ps={5} listStyleType="disc" fontSize="sm">
      {items.map((item, i) => (
        <Box as="li" key={i}>
          {item}
        </Box>
      ))}
    </Stack>
  );
}
