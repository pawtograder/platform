/**
 * Turns classified values into the strings the taint set matches (bug reporter spec, package 2).
 *
 * Every pattern is case- and whitespace-normalized with `normalizeForMatch`, so the matcher must
 * normalize the text it scans the same way. Patterns under `MIN_MATCH_LENGTH` characters, initials,
 * and grades are never produced: those are blocked structurally (`<ReportBlock>`, package 3) instead,
 * because matching "87" or "J." would redact unrelated text without protecting anyone.
 */
import type { PiiKind } from "./privacyTypes";

export const MIN_MATCH_LENGTH = 3;

/** Lower case, NFKC, runs of whitespace collapsed to one space, trimmed. */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** "J", "JD", "J.", "J.D.", "J. D.", "D., J." (up to three letters when each has a dot). */
function isInitials(token: string): boolean {
  const t = token.replace(/[\s,]/g, "");
  return /^(?:\p{L}\.?){1,2}$/u.test(t) || /^(?:\p{L}\.){1,3}$/u.test(t);
}

function keep(out: Set<string>, candidate: string) {
  const n = normalizeForMatch(candidate);
  if (n.length < MIN_MATCH_LENGTH || isInitials(n)) return;
  out.add(n);
}

/**
 * Variants of a person's name: the full name, its first and last tokens, "Last, First", and
 * "First Last" when the input is already in sortable "Last, First" form.
 */
export function nameVariants(name: string): string[] {
  const out = new Set<string>();
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  keep(out, trimmed);
  const sortable = trimmed.match(/^([^,]+),\s*(.+)$/);
  const ordered = sortable ? `${sortable[2]} ${sortable[1]}` : trimmed;
  const tokens = ordered.split(" ").filter((t) => t.length > 0);
  if (tokens.length > 1) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    keep(out, first);
    keep(out, last);
    keep(out, `${first} ${last}`);
    keep(out, `${last}, ${first}`);
    keep(out, ordered);
  }
  return [...out];
}

/** The staff-facing form rendered by `components/ui/person-name.tsx`: "Pseudonym (Real Name)". */
export function personNameDisplay(name: string, realName: string): string {
  return `${name} (${realName})`;
}

/** Variants of both names plus the `name (real_name)` display form. */
export function personNameVariants(name: string, realName?: string | null): string[] {
  const out = new Set(nameVariants(name));
  if (realName) {
    for (const v of nameVariants(realName)) out.add(v);
    keep(out, personNameDisplay(name, realName));
  }
  return [...out];
}

/**
 * The normalized strings to add to the taint set for one classified value. Empty for `grade` and
 * `none`, which are never string-matched.
 */
export function matchPatterns(value: string, kind: PiiKind): string[] {
  switch (kind) {
    case "none":
    case "grade":
      return [];
    case "name":
      return nameVariants(value);
    case "email": {
      const out = new Set<string>();
      keep(out, value);
      const at = value.lastIndexOf("@");
      if (at > 0) keep(out, value.slice(0, at));
      return [...out];
    }
    case "handle":
    case "free_text": {
      const out = new Set<string>();
      keep(out, value);
      return [...out];
    }
  }
}
