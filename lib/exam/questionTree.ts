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
  const childrenOf = childrenByParent(questions);
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

export type PointsNode = { client_id: string; parent_client_id: string | null; points: number | null };
export type PointsMismatch = { points: number; partsTotal: number };

/**
 * Questions with parts whose own points their answerable parts don't add up to (#1370), by client_id.
 *
 * Only questions with no parts count toward the exam total, and the editor hides the points input
 * on a question with parts. So when Auto-extract puts "[7 pts]" on 3(b) and nothing on its four
 * parts, or an instructor adds parts to a question that already had points, those points are saved
 * but count for nothing. A question with parts at 0 or no points is normal and isn't listed.
 */
export function parentPointsMismatches(questions: PointsNode[]): Map<string, PointsMismatch> {
  const out = new Map<string, PointsMismatch>();
  for (const { question, parts } of questionsWithParts(questions)) {
    if (!question.points) continue;
    const partsTotal = parts.reduce((sum, p) => sum + (p.points ?? 0), 0);
    // Points can be decimals, and 0.1 + 0.2 isn't 0.3 in floating point.
    if (Math.abs(partsTotal - question.points) > 1e-9) {
      out.set(question.client_id, { points: question.points, partsTotal });
    }
  }
  return out;
}

/**
 * Gives a question's points to its answerable parts when none of them have any (#1370), for
 * Auto-extract's proposal. Gemini sometimes reads "[7 pts]" onto 3(b) and nothing onto its four
 * calls, and only parts count toward the total, so the exam would come out 7 short.
 *
 * The points are split as evenly as whole points allow, with the extra points on the first parts
 * (7 over four calls is 2, 2, 2, 1), so the total stays what was printed. Whole points because a
 * leaf's rubric criterion stores its total as an integer, so 1.75 would be rounded there. Even
 * weights are a guess, but a right total with weights to adjust beats a wrong total nobody notices.
 *
 * Deeper questions go first, so a level-1 question is only split when its level-2 parts don't say
 * how its points divide. Parts that already have some points are left alone, and so is a question
 * whose points aren't whole; parentPointsMismatches reports both.
 */
export function spreadParentPoints<T extends PointsNode>(questions: T[]): T[] {
  const points = new Map(questions.map((q) => [q, q.points]));
  for (const { question, parts } of questionsWithParts(questions)) {
    const own = points.get(question) ?? 0;
    if (own > 0 && Number.isInteger(own) && parts.length > 0 && parts.every((p) => !points.get(p))) {
      const share = Math.floor(own / parts.length);
      const extra = own % parts.length;
      parts.forEach((p, i) => points.set(p, share + (i < extra ? 1 : 0)));
    }
  }
  return questions.map((q) => (points.get(q) === q.points ? q : { ...q, points: points.get(q) ?? q.points }));
}

/**
 * Each question that has parts, with the parts under it that have none of their own, deepest
 * questions first. Only questions under a top-level one are walked, so a bad id from Auto-extract
 * (a question that is its own parent, or two with the same id) can't send this round in circles.
 */
function questionsWithParts<T extends PointsNode>(questions: T[]): { question: T; parts: T[] }[] {
  const childrenOf = childrenByParent(questions);
  const seen = new Set<T>();
  const out: { question: T; parts: T[] }[] = [];
  const walk = (q: T): T[] => {
    if (seen.has(q)) return [];
    seen.add(q);
    const children = childrenOf.get(q.client_id);
    if (!children) return [q];
    const parts = children.flatMap(walk);
    out.push({ question: q, parts });
    return parts;
  };
  for (const root of childrenOf.get(null) ?? []) walk(root);
  return out;
}

/** Each question's direct children, in input order. Top-level questions are under null. */
function childrenByParent<T extends { parent_client_id: string | null }>(questions: T[]): Map<string | null, T[]> {
  const childrenOf = new Map<string | null, T[]>();
  for (const q of questions) {
    const key = q.parent_client_id ?? null;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(q);
    childrenOf.set(key, siblings);
  }
  return childrenOf;
}
