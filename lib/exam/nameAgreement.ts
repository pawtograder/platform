/**
 * Whether the name read off a scanned exam names the roster student it is about to be confirmed
 * as (#1265). Deliberately strict: the same words, ignoring order, case, accents, punctuation and
 * spacing. Anything else, a typo or a missing initial included, counts as a different name, so the
 * instructor has to look and acknowledge it. A similarity score would let a near miss, which can be
 * a different student, through without anyone seeing it.
 */
export function normalizeName(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

/** True when both names have the same words. A missing name is never equivalent to anything. */
export function namesEquivalent(detected: string | null | undefined, rosterName: string | null | undefined): boolean {
  const a = normalizeName(detected);
  const b = normalizeName(rosterName);
  return a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i]);
}
