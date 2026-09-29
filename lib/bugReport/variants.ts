import { MIN_MATCH_LENGTH, normalizePattern } from "./ahoCorasick";

/**
 * The strings a PII value can appear as on screen, for taint matching.
 *
 * A name is also rendered as its first and last tokens, as "Last, First", and by
 * `components/ui/person-name.tsx` as `name (real_name)` when a staff member views a pseudonym.
 * Other kinds match only as themselves. There is no separate lower-case variant: `AhoCorasick`
 * matching is case- and whitespace-insensitive, so the result keeps one spelling per normalized
 * form. Strings shorter than MIN_MATCH_LENGTH are left out: they are blocked structurally, never
 * matched as text.
 */
export function variants(value: string, options: { kind?: string; realName?: string } = {}): string[] {
  const { kind = "name", realName } = options;
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (!s) return;
    const trimmed = s.trim();
    if (trimmed.length >= MIN_MATCH_LENGTH) out.add(trimmed);
  };

  add(value);
  if (kind === "name") {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      add(first);
      add(last);
      add(`${last}, ${first}`);
      add(`${last}, ${tokens.slice(0, -1).join(" ")}`);
    }
    if (realName) add(`${value} (${realName})`);
  }
  const seen = new Set<string>();
  return [...out].filter((s) => {
    const key = normalizePattern(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
