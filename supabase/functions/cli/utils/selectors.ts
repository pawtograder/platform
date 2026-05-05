/**
 * Selector resolution for assessment export — turn a list of CLI-provided
 * id/slug/glob selectors into a concrete row set.
 *
 * Selector forms:
 *   - All-digit string or number  → match by id
 *   - String containing * or ?    → minimatch-style glob on slug
 *   - Anything else               → exact slug match
 *
 * Partial-name matches are NOT supported because slugs and titles overlap
 * in this codebase and ambiguous matches would silently expand the export.
 */

export interface Identifiable {
  id: number;
  slug: string | null;
}

export function selectorPredicate(selector: string | number): (row: Identifiable) => boolean {
  const s = typeof selector === "number" ? String(selector) : selector;
  if (/^\d+$/.test(s)) {
    const id = Number(s);
    return (row) => row.id === id;
  }
  if (s.includes("*") || s.includes("?")) {
    const escaped = s
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const re = new RegExp(`^${escaped}$`);
    return (row) => row.slug !== null && re.test(row.slug);
  }
  return (row) => row.slug === s;
}

/**
 * Resolve a list of selectors against candidate rows. Order of `resolved` is
 * preserved by candidate order (not selector order) so a glob doesn't shuffle
 * the export. Selectors that match no candidates are returned in `unmatched`
 * so callers can surface them to the user instead of silently dropping them.
 */
export function resolveSelectors<T extends Identifiable>(
  selectors: Array<string | number> | undefined,
  candidates: T[]
): { resolved: T[]; unmatched: Array<string | number> } {
  if (!selectors || selectors.length === 0) {
    return { resolved: candidates, unmatched: [] };
  }
  const matchedIds = new Set<number>();
  const unmatched: Array<string | number> = [];
  for (const raw of selectors) {
    const pred = selectorPredicate(raw);
    const before = matchedIds.size;
    for (const row of candidates) {
      if (pred(row)) matchedIds.add(row.id);
    }
    if (matchedIds.size === before) unmatched.push(raw);
  }
  return { resolved: candidates.filter((c) => matchedIds.has(c.id)), unmatched };
}
