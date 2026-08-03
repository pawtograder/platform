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
    p = p.replace(tokenBoundaryPattern(value, "g"), `{{${key}}}`);
  }
  for (const [re, placeholder] of GENERIC_RULES) p = p.replace(re, placeholder);
  return p.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Escape regex metacharacters in a literal chunk. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a seed value only as a whole token. A bare substring replace turns the
 * incidental digits of unrelated speech into named placeholders — with
 * autograderScore="5", "heading, level 5" normalizes to "heading, level
 * {{autograderscore}}", which is enough to satisfy a read-task needle check the
 * score cell never actually produced. The word-boundary lookarounds are applied
 * only on the sides where the value itself ends in a word character, so values
 * with punctuation edges (e.g. "#3", "O'Brien") still match.
 *
 * Exported because the read-task predicates need the same whole-token rule when
 * checking an agent's answer against seed-derived ground truth.
 */
export function tokenBoundaryPattern(value: string, flags = ""): RegExp {
  const left = /^\w/.test(value) ? "(?<!\\w)" : "";
  const right = /\w$/.test(value) ? "(?!\\w)" : "";
  return new RegExp(`${left}${escapeRegExp(value)}${right}`, flags);
}

/** Template → regex source (generic placeholders act as class wildcards). */
function templateToPattern(template: string): string {
  return template
    .split(/(\{\{(?:number|date|time)\}\})/)
    .map((chunk) =>
      chunk === "{{number}}"
        ? "\\d+"
        : chunk === "{{date}}" || chunk === "{{time}}"
          ? // Grouped: an ungrouped `|` here would split the whole anchored
            // pattern into two top-level alternatives, so a template like
            // "due {{date}} for assignment one" would match any phrase merely
            // ending in "for assignment one".
            "(?:\\{\\{(?:date|time)\\}\\}|[\\w:, ]+)"
          : escapeRegExp(chunk)
    )
    .join("");
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
  return new RegExp(`^${templateToPattern(template)}$`).test(liveNormalized);
}

/**
 * Prefix form at a word boundary: real assistive tech can compute a LONGER
 * accessible name than the virtual SR for the same control (observed live:
 * VSR-recorded milestone "post" vs VoiceOver's "Post as Agent Student").
 * Guarded to templates of ≥4 chars so trivial fragments can't hijack a
 * resync walk.
 */
export function templatePrefixMatches(template: string, livePhrase: string, replayBindings: Bindings): boolean {
  if (template.length < 4) return false;
  const liveNormalized = normalizePhrase(livePhrase, replayBindings);
  if (liveNormalized === null) return false;
  return new RegExp(`^${templateToPattern(template)}([\\s,]|$)`).test(liveNormalized);
}
