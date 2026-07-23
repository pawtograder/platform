/**
 * Spoken-phrase normalization for deterministic replay (a11y-judge v2, Wave 4).
 *
 * Rules derived empirically in Spike S3 (fixtures: agent/__fixtures__/s3/):
 * two runs on entirely different seeds produce identical logs after
 *   1. seed-binding substitution (longest value first),
 *   2. dropping realtime-churn noise phrases,
 *   3. {{time}}/{{date}}/{{number}} placeholders,
 *   4. lowercase + whitespace collapse.
 *
 * A milestone recorded on seed A becomes a TEMPLATE (placeholders in, seed
 * values out); at replay on seed B the template is matched against the live
 * phrase normalized with B's bindings. {{number}}/{{date}}/{{time}} match
 * any value of their class; named bindings must correspond.
 */

export type Bindings = Record<string, string>;

export const REPLAY_NOISE_PATTERNS: RegExp[] = [/realtime connection/i, /connections? active/i];

const GENERIC_RULES: Array<[RegExp, string]> = [
  [/\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi, "{{time}}"],
  [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(, \d{4})?\b/gi, "{{date}}"],
  [/\b\d+\b/g, "{{number}}"]
];

/**
 * Normalize a phrase into its template form. Returns null for noise phrases
 * (they must not become milestones — they may not replay).
 */
export function normalizePhrase(phrase: string, bindings: Bindings): string | null {
  if (REPLAY_NOISE_PATTERNS.some((re) => re.test(phrase))) return null;
  let p = phrase;
  for (const [key, value] of Object.entries(bindings).sort((x, y) => y[1].length - x[1].length)) {
    if (!value) continue;
    p = p.split(value).join(`{{${key}}}`);
  }
  for (const [re, placeholder] of GENERIC_RULES) p = p.replace(re, placeholder);
  return p.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Escape regex metacharacters in a literal chunk. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a live phrase (normalized under the REPLAY run's bindings) satisfy a
 * recorded template? Exact equality after both normalize, except the generic
 * placeholders match any content of their class.
 */
export function templateMatches(template: string, livePhrase: string, replayBindings: Bindings): boolean {
  const liveNormalized = normalizePhrase(livePhrase, replayBindings);
  if (liveNormalized === null) return false;
  if (template === liveNormalized) return true;
  // Generic placeholders in the template act as wildcards for their class.
  const pattern = template
    .split(/(\{\{(?:number|date|time)\}\})/)
    .map((chunk) =>
      chunk === "{{number}}"
        ? "\\d+"
        : chunk === "{{date}}" || chunk === "{{time}}"
          ? "\\{\\{(?:date|time)\\}\\}|[\\w:, ]+"
          : escapeRegExp(chunk)
    )
    .join("");
  return new RegExp(`^${pattern}$`).test(liveNormalized);
}
