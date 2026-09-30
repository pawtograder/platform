/**
 * Canary values for the bug reporter's taint trace (spec package 2a, §7.2).
 *
 * A canary is a synthetic PII value that is unique enough to find wherever it travels: in a
 * PostgREST response, a realtime frame, an RSC payload, or the DOM. Generated canaries carry
 * "anchor" tokens, invented words such as "zorvik" that occur nowhere else, so a scan only has to
 * split text into tokens and look each one up. Values a spec chose itself ("IA Student") have no
 * anchor and are matched as whole phrases instead.
 *
 * The registry shape (`Map<value, {kind, column, rowId}>`) is the one package 0's
 * `scanForCanaries(bytes, registry)` takes, so the same registry feeds the upload leak tests.
 */
import { randomInt } from "node:crypto";
import { normalizeForMatch, variants } from "@/lib/bugReport/variants";
import type { CanaryEntry as BaseCanaryEntry } from "./canaries";

export type CanaryKind = "name" | "email" | "handle" | "grade" | "free_text";

/**
 * What a canary stands for: package 0's `CanaryEntry` (kind, `table.column`, row, real name),
 * narrowed to the PII kinds and with the anchor tokens the trace matches on. A registry of these is
 * assignable to package 0's `CanaryRegistry`, so `scanForCanaries` takes it.
 */
export type CanaryEntry = BaseCanaryEntry & {
  kind: CanaryKind;
  /**
   * Invented tokens (lower case) that only this seed run produced. A scan finds the canary through
   * any of them. Absent for values a spec chose itself, which are matched as whole phrases.
   */
  anchors?: string[];
};

/** Canary value → where it came from. */
export type CanaryRegistry = Map<string, CanaryEntry>;

/**
 * Every canary seeded in this Playwright worker. The taint trace scans for these; seed helpers
 * write here as well as to any registry the caller passes.
 */
export const workerCanaries: CanaryRegistry = new Map();

/** True when the suite runs under the taint trace (`BUG_REPORT_TRACE=1`). */
export function isTraceMode(): boolean {
  return process.env.BUG_REPORT_TRACE === "1" || process.env.BUG_REPORT_TRACE === "true";
}

/**
 * The `canary` option of the seed helpers. `true` seeds canaries into `workerCanaries`; an object
 * can name another registry to fill too. Under trace mode the helpers default to canaries.
 */
export type CanaryOption =
  | boolean
  | {
      registry?: CanaryRegistry;
      /** Also set `users.github_username`. Off by default: some pages change when a user has linked GitHub. */
      githubUsername?: boolean;
      /** Also set `users.discord_username`. Off by default for the same reason. */
      discordUsername?: boolean;
    };

export type ResolvedCanary = {
  registries: CanaryRegistry[];
  githubUsername: boolean;
  discordUsername: boolean;
};

/** Resolves a helper's `canary` option, applying the trace-mode default. Null means no canaries. */
export function resolveCanary(option: CanaryOption | undefined): ResolvedCanary | null {
  const effective = option ?? (isTraceMode() ? true : false);
  if (effective === false) return null;
  const registries = [workerCanaries];
  if (typeof effective === "object" && effective.registry && effective.registry !== workerCanaries) {
    registries.push(effective.registry);
  }
  return {
    registries,
    githubUsername: typeof effective === "object" ? (effective.githubUsername ?? false) : false,
    discordUsername: typeof effective === "object" ? (effective.discordUsername ?? false) : false
  };
}

/** Records a canary in every registry of `canary`. */
export function registerCanary(canary: ResolvedCanary, value: string, entry: CanaryEntry): void {
  for (const registry of canary.registries) registry.set(value, entry);
}

/**
 * Registers a value a spec chose itself (not generated), when it is distinctive enough to match as
 * a phrase: at least 6 characters with a space or an `@`. Shorter or single-word values would
 * match unrelated text, so they are left out of the trace.
 */
export function registerChosenValue(canary: ResolvedCanary, value: string | null | undefined, entry: CanaryEntry) {
  if (!value) return;
  const normalized = normalizeForMatch(value);
  if (normalized.length < 6 || !/[ @]/.test(normalized)) return;
  registerCanary(canary, value, { ...entry, anchors: undefined });
}

// --- generation ---------------------------------------------------------------------------------

// Rare letters lead each word so it reads as a name but is not an English word.
const LEADS = ["z", "q", "x", "v", "k", "zh", "kv", "vr", "xa"];
const ONSETS = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "br", "dr", "tr", "gl", "sk"];
const VOWELS = ["a", "e", "i", "o", "u", "ae", "ou", "ei"];
const CODAS = ["", "n", "r", "l", "x", "k", "m", "s", "v"];

const issued = new Set<string>();

function pick<T>(xs: readonly T[]): T {
  return xs[randomInt(xs.length)];
}

/**
 * A pronounceable invented word, lower case, 6 to 12 letters, unique within this process. With
 * about 10^8 combinations per call, two workers colliding in one run is negligible.
 */
export function canaryWord(): string {
  for (;;) {
    const word =
      pick(LEADS) +
      pick(VOWELS) +
      pick(CODAS) +
      pick(ONSETS) +
      pick(VOWELS) +
      pick(CODAS) +
      pick(ONSETS) +
      pick(VOWELS);
    if (word.length < 6 || word.length > 12 || issued.has(word)) continue;
    issued.add(word);
    return word;
  }
}

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** A person's name: two invented tokens, e.g. "Zorvik Quellmar". */
export function canaryPersonName(): { first: string; last: string; full: string; sortable: string } {
  const first = capitalize(canaryWord());
  const last = capitalize(canaryWord());
  return { first, last, full: `${first} ${last}`, sortable: `${last}, ${first}` };
}

/** An email with a unique local part. `prefix` keeps conventions such as "instructor-" that seeds rely on. */
export function canaryEmail(prefix: string): { email: string; anchor: string } {
  const anchor = canaryWord();
  return { email: `${prefix}${anchor}@pawtograder.net`, anchor };
}

/** A GitHub- or Discord-style username. */
export function canaryHandle(): { handle: string; anchor: string } {
  const anchor = canaryWord();
  return { handle: `${anchor}-${randomInt(10, 99)}`, anchor };
}

const SENTENCES = [
  (w: string) => `${capitalize(w)} keeps failing on the second test case and I am not sure why.`,
  (w: string) => `${capitalize(w)} loop never terminates when the list is empty.`,
  (w: string) => `${capitalize(w)} returns null after I call reset twice in a row.`,
  (w: string) => `${capitalize(w)} method looks right to me but the grader disagrees.`
];

/**
 * Free text: a sentence that starts with its anchor token, so a truncated preview still shows it.
 */
export function canarySentence(): { text: string; anchor: string } {
  const anchor = canaryWord();
  return { text: pick(SENTENCES)(anchor), anchor };
}

const issuedGrades = new Set<string>();

/** Decimals that common fractions end in (thirds, quarters, eighths), so often seen in other numbers. */
const COMMON_CENTS = new Set([12, 25, 37, 62, 67, 75, 87]);

/**
 * A grade with two decimals that no computed score is likely to produce by accident, such as 87.31.
 * The two decimals are distinct digits and not the start of a common fraction (.33, .25, .67), so
 * the grade is less likely to turn up inside some other number. Returned as the number and the
 * string a page renders.
 */
export function canaryGrade(max = 100): { value: number; text: string } {
  for (;;) {
    const whole = randomInt(Math.max(1, Math.floor(max * 0.55)), Math.max(2, Math.floor(max * 0.97)));
    const cents = randomInt(11, 99);
    if (cents % 10 === 0 || cents % 11 === 0 || COMMON_CENTS.has(cents)) continue;
    const text = `${whole}.${cents}`;
    if (issuedGrades.has(text)) continue;
    issuedGrades.add(text);
    return { value: Number(text), text };
  }
}

// --- variants and matching ----------------------------------------------------------------------

/**
 * The strings a canary can appear as (package 0's `variants`, the one `scanForCanaries` expands
 * canaries with): the value, and for names the first and last tokens, "Last, First", and the
 * `name (real_name)` display form.
 */
export function canaryVariants(value: string, entry?: Pick<CanaryEntry, "kind" | "realName">): string[] {
  return variants(value, { kind: entry?.kind ?? "name", realName: entry?.realName });
}

/** Token pattern shared by the Node matcher and the in-page scanner. Keeps "87.31" whole. */
export const TOKEN_PATTERN_SOURCE = "[\\p{L}\\p{N}]+(?:\\.\\d+)?";

export type CanaryHit = { canary: string; entry: CanaryEntry; matched: string };

export type PagePatterns = { version: number; tokens: string[]; phrases: string[] };

/**
 * Finds canaries in text through their anchor tokens, or as whole phrases for chosen values.
 * Rebuilt lazily when the registry grows.
 */
export class CanaryMatcher {
  private builtSize = -1;
  private tokens = new Map<string, string[]>();
  private phrases = new Map<string, string[]>();

  constructor(private readonly registry: CanaryRegistry = workerCanaries) {}

  private build() {
    if (this.builtSize === this.registry.size) return;
    this.tokens.clear();
    this.phrases.clear();
    for (const [value, entry] of this.registry) {
      const keys = entry.anchors?.length ? entry.anchors : null;
      const target = keys ? this.tokens : this.phrases;
      for (const key of keys ?? [normalizeForMatch(value)]) {
        const list = target.get(key) ?? [];
        list.push(value);
        target.set(key, list);
      }
    }
    this.builtSize = this.registry.size;
  }

  get size(): number {
    return this.registry.size;
  }

  /** Every canary found in `text`, once per canary. */
  find(text: string): CanaryHit[] {
    this.build();
    if (this.registry.size === 0 || !text) return [];
    const found = new Map<string, string>();
    const normalized = normalizeForMatch(text);
    for (const m of normalized.matchAll(new RegExp(TOKEN_PATTERN_SOURCE, "gu"))) {
      const values = this.tokens.get(m[0]);
      if (values) for (const v of values) if (!found.has(v)) found.set(v, m[0]);
    }
    for (const [phrase, values] of this.phrases) {
      if (normalized.includes(phrase)) for (const v of values) if (!found.has(v)) found.set(v, phrase);
    }
    return [...found].map(([canary, matched]) => ({ canary, entry: this.registry.get(canary)!, matched }));
  }

  /** The patterns the in-page DOM scanner needs. */
  forPage(): PagePatterns {
    this.build();
    return { version: this.registry.size, tokens: [...this.tokens.keys()], phrases: [...this.phrases.keys()] };
  }
}
