export type TreeNode = { client_id: string; parent_client_id: string | null; ordinal: number };

/**
 * Orders a flat question list so each question comes right after its parent, with siblings by
 * ordinal (#1264). The database returns questions by level then ordinal, and ordinals are per parent,
 * so rendering that order as-is interleaves siblings from different parents.
 *
 * A question that can't be reached from a top-level one (its parent id isn't in the list, e.g. a bad
 * id from Auto-extract) comes after the rest, with its own children under it, so no question disappears.
 */
export function preorder<T extends TreeNode>(questions: T[]): T[] {
  const childrenOf = new Map<string | null, T[]>();
  for (const q of questions) {
    const key = q.parent_client_id ?? null;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(q);
    childrenOf.set(key, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.ordinal - b.ordinal);

  const out: T[] = [];
  const seen = new Set<string>();
  const add = (q: T) => {
    if (seen.has(q.client_id)) return;
    seen.add(q.client_id);
    out.push(q);
    for (const child of childrenOf.get(q.client_id) ?? []) add(child);
  };
  for (const q of childrenOf.get(null) ?? []) add(q);
  for (const q of questions) add(q);
  return out;
}
