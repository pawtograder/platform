/**
 * Every What's New walkthrough id and every page that can show one. This file has no React
 * imports, so Node code (tests/e2e/TestingUtils.ts, scripts/whats-new/suggest.ts) can read it.
 *
 * An id is the walkthrough's row key in public.user_whats_new_seen. A new version of a walkthrough
 * gets a new id, so people who saw the old one see the new one once.
 *
 * tests/unit/whats-new-registry.test.ts fails when this list and lib/whatsNew/registry.ts disagree.
 */
export const WHATS_NEW_IDS = {
  OH_ESCALATION: "oh-escalation:v1"
} as const;

export type WhatsNewId = (typeof WHATS_NEW_IDS)[keyof typeof WHATS_NEW_IDS];

export const ALL_WHATS_NEW_IDS: readonly WhatsNewId[] = Object.values(WHATS_NEW_IDS);

/** Pages that render <WhatsNew page="..." />. Add a key when a new page mounts the component. */
export const WHATS_NEW_PAGES = {
  /** The staff and student office hours header (components/help-queue/office-hours-header.tsx). */
  "office-hours": "Office Hours"
} as const;

export type WhatsNewPage = keyof typeof WHATS_NEW_PAGES;

export const WHATS_NEW_AUDIENCES = ["staff", "students", "everyone"] as const;

export type WhatsNewAudience = (typeof WHATS_NEW_AUDIENCES)[number];
