/**
 * Step 3 of the What's New suggestion bot (docs/prd-whats-new-bot.md): turn the model's decision
 * into lib/whatsNew/entries/<slug>.tsx. The model writes text only, and every piece of its text
 * goes into the file as a JSON string literal, so the file always parses whatever the text says.
 */

export type SuggestedStep = {
  title: string;
  points: string[];
  /** The component in the diff whose look the step's preview should copy. */
  previewOf: string | null;
};

export type SuggestedEntry = {
  audience: "staff" | "students" | "everyone";
  page: string;
  feature: string | null;
  title: string;
  intro: string;
  steps: SuggestedStep[];
};

/** Days a new walkthrough opens on its own, counted from the merge. */
export const SHOW_FOR_DAYS = 60;

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "walkthrough"
  );
}

/** The YYYY-MM-DD date `days` after `from`, in UTC. */
export function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** WHATS_NEW_IDS key for a slug, e.g. "queue-health" -> "QUEUE_HEALTH". */
export function idKey(slug: string): string {
  return slug.toUpperCase().replace(/-/g, "_");
}

const str = (text: string) => JSON.stringify(text);

export function renderEntryFile(
  entry: SuggestedEntry,
  { slug, prNumber, mergedAt }: { slug: string; prNumber: number; mergedAt: Date }
): string {
  const steps = entry.steps
    .map((step) => {
      const preview = step.previewOf
        ? `TODO: a static preview of ${step.previewOf}. Copy its markup from the diff, as the escalation entry does.`
        : "TODO: a static preview of the control this step describes.";
      const points = step.points.map((point) => `              ${str(point)}`).join(",\n");
      return `    {
      title: ${str(step.title)},
      body: (
        <Stack gap={4}>
          <Preview>
            <Text fontSize="sm">{${str(preview)}}</Text>
          </Preview>
          <Points
            items={[
${points}
            ]}
          />
        </Stack>
      )
    }`;
    })
    .join(",\n");

  return `"use client";

import { Stack, Text } from "@chakra-ui/react";
import { defineWhatsNew, Points, Preview } from "../define";
import { WHATS_NEW_IDS } from "../ids";

/*
 * Drafted by scripts/whats-new/suggest.ts for #${prNumber}. Before merging: replace each TODO
 * preview with a static copy of the real control, check every point against the shipped UI, and
 * add the id to WHATS_NEW_IDS (lib/whatsNew/ids.ts) and the entry to WHATS_NEW_ENTRIES
 * (lib/whatsNew/registry.ts).
 */

export default defineWhatsNew({
  id: WHATS_NEW_IDS.${idKey(slug)},
  page: ${str(entry.page)},
  audience: ${str(entry.audience)},${entry.feature ? `\n  feature: ${str(entry.feature)},` : ""}
  showUntil: ${str(addDays(mergedAt, SHOW_FOR_DAYS))},
  title: ${str(entry.title)},
  intro: <Text>{${str(entry.intro)}}</Text>,
  steps: [
${steps}
  ]
});
`;
}
