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

/** The strings a scan looks for, for one canary. */
export type VariantsOf = (canary: string, entry: CanaryEntry) => string[];

const defaultVariants: VariantsOf = (canary, entry) => variants(canary, { kind: entry.kind, realName: entry.realName });

const automata = new WeakMap<CanaryRegistry, Map<VariantsOf, { size: number; ac: AhoCorasick<Tagged> }>>();

/** The registry's automaton, rebuilt when it has grown (registries only gain entries). */
function automatonFor(registry: CanaryRegistry, variantsOf: VariantsOf): AhoCorasick<Tagged> {
  let byVariants = automata.get(registry);
  if (!byVariants) automata.set(registry, (byVariants = new Map()));
  const cached = byVariants.get(variantsOf);
  if (cached && cached.size === registry.size) return cached.ac;
  const ac = new AhoCorasick<Tagged>();
  for (const [canary, entry] of registry) {
    for (const variant of variantsOf(canary, entry)) {
      ac.add(variant, { canary, variant, entry });
    }
  }
  byVariants.set(variantsOf, { size: registry.size, ac });
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
  registry: CanaryRegistry,
  /** Which forms of each canary to look for; by default `variants` of it */
  variantsOf: VariantsOf = defaultVariants
): CanaryHit[] {
  const ac = automatonFor(registry, variantsOf);
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

/**
 * A grade canary such as "72.52" found inside a longer number (an SVG path's "M572.52 241.4") is
 * a coincidence, not the grade: the scan matches substrings. True for grade hits with a digit, or
 * a digit-and-dot, right next to them in `text` (the decoded source the hit came from).
 */
export function isNumberFragment(text: string, hit: CanaryHit): boolean {
  if (hit.entry.kind !== "grade") return false;
  const before = text[hit.offset - 1] ?? "";
  const after = text[hit.offset + hit.matched.length] ?? "";
  return /[\d.]/.test(before) || /\d/.test(after);
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
