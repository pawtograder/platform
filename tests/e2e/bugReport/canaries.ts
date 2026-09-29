import { AhoCorasick } from "@/lib/bugReport/ahoCorasick";
import type { PiiKind } from "@/lib/bugReport/privacyTypes";
import { variants } from "@/lib/bugReport/variants";

export { variants };

/** What a canary stands for: its PII kind, the `table.column` it was seeded into, and the row. */
export type CanaryEntry = {
  kind: Exclude<PiiKind, "none">;
  /** "table.column", e.g. "profiles.name" */
  column: string;
  rowId: string | number;
  /** For a pseudonymous profile name: the real name it stands in for, to add the PersonName form */
  realName?: string;
};

/** Canary value → where it came from. Built by the canary seed (package 2a). */
export type CanaryRegistry = Map<string, CanaryEntry>;

export type CanaryHit = {
  /** The registered canary value */
  canary: string;
  /** The variant of it that matched (the canary itself, "Last, First", ...) */
  matched: string;
  entry: CanaryEntry;
  /** Index into the `bytes` array passed to scanForCanaries */
  source: number;
  /** Character offset of the match in the decoded source */
  offset: number;
  /** Up to 40 characters either side, for the failure message */
  context: string;
};

type Tagged = { canary: string; variant: string; entry: CanaryEntry };

function automatonFor(registry: CanaryRegistry): AhoCorasick<Tagged> {
  const ac = new AhoCorasick<Tagged>();
  for (const [canary, entry] of registry) {
    for (const variant of variants(canary, { kind: entry.kind, realName: entry.realName })) {
      ac.add(variant, { canary, variant, entry });
    }
  }
  return ac;
}

const decoder = new TextDecoder();

/**
 * Aho-Corasick scan of uploaded bytes for every canary and its variants (spec §7.2), case- and
 * whitespace-insensitive. Returns every hit; a leak test asserts the result is `[]`.
 *
 * Pass decompressed bytes: a canary inside a zlib stream is invisible here. `captureTunnel`'s
 * `uploadedBytes()` already inflates recordings. Values are also matched inside JSON strings as
 * is, which covers plain ASCII canaries; the seed should avoid characters JSON escapes.
 */
export function scanForCanaries(
  bytes: Uint8Array | string | readonly (Uint8Array | string)[],
  registry: CanaryRegistry
): CanaryHit[] {
  const ac = automatonFor(registry);
  const sources = typeof bytes === "string" || bytes instanceof Uint8Array ? [bytes] : bytes;
  const hits: CanaryHit[] = [];
  sources.forEach((source, index) => {
    const text = typeof source === "string" ? source : decoder.decode(source);
    for (const match of ac.search(text)) {
      for (const tagged of match.values) {
        hits.push({
          canary: tagged.canary,
          matched: tagged.variant,
          entry: tagged.entry,
          source: index,
          offset: match.start,
          context: text.slice(Math.max(0, match.start - 40), match.end + 40)
        });
      }
    }
  });
  return hits;
}

/** Formats hits for an assertion message. */
export function describeHits(hits: CanaryHit[]): string {
  return hits
    .map(
      (h) =>
        `${h.entry.kind} ${h.entry.column}#${h.entry.rowId} as "${h.matched}" in source ${h.source}: …${h.context}…`
    )
    .join("\n");
}
