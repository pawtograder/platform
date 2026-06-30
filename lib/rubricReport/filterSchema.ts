import { z } from "zod";

/**
 * Typed filter AST for the instructor rubric report. Mirrors the closed predicate
 * set understood by the get_rubric_check_application_stats RPC. The same shape is
 * validated client-side (here) AND re-validated + interpreted server-side, so no
 * instructor input is ever turned into SQL. See
 * supabase/migrations/20260603160000_rubric_check_application_stats_rpc.sql.
 */

export const MAX_FILTER_DEPTH = 25;
export const MAX_FILTER_ARGS = 50;

export type RubricFilterLeaf =
  | { checkApplied: number }
  | { optionSelected: { checkId: number; optionIndex: number } }
  | { section: string }
  | { lab: string }
  | { scoreAtLeast: number }
  | { scoreAtMost: number };

export type RubricFilter = RubricFilterLeaf | { op: "and" | "or" | "not"; args: RubricFilter[] };

const leafSchema: z.ZodType<RubricFilterLeaf> = z.union([
  z.object({ checkApplied: z.number().int() }).strict(),
  z
    .object({ optionSelected: z.object({ checkId: z.number().int(), optionIndex: z.number().int().min(0) }).strict() })
    .strict(),
  z.object({ section: z.string() }).strict(),
  z.object({ lab: z.string() }).strict(),
  z.object({ scoreAtLeast: z.number() }).strict(),
  z.object({ scoreAtMost: z.number() }).strict()
]);

/** Recursive schema enforcing the closed predicate set + per-node arg cap. */
/** Recursive schema enforcing the closed predicate set + per-node arg cap. */
export const rubricFilterSchema: z.ZodType<RubricFilter> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or", "not"]), args: z.array(rubricFilterSchema).max(MAX_FILTER_ARGS) }).strict(),
    leafSchema
  ])
);

const isGroupNode = (node: RubricFilter): node is { op: "and" | "or" | "not"; args: RubricFilter[] } => "op" in node;

/** Greatest nesting depth of a (parsed) filter tree. Leaves are depth 1. */
export function filterDepth(node: RubricFilter): number {
  if (isGroupNode(node)) {
    const childDepths = node.args.map((arg) => filterDepth(arg));
    return 1 + Math.max(0, ...childDepths);
  }
  return 1;
}

/** Returns an error message if any `not` node does not have exactly one child. */
function notArityError(node: RubricFilter): string | null {
  if (!isGroupNode(node)) return null;
  if (node.op === "not" && node.args.length !== 1) return "NOT requires exactly one condition";
  for (const arg of node.args) {
    const err = notArityError(arg);
    if (err) return err;
  }
  return null;
}

export type FilterValidationResult = { ok: true; value: RubricFilter } | { ok: false; error: string };

/**
 * Validate an untyped value as a RubricFilter: shape (closed predicate set, no extra
 * keys), arg cap, nesting depth, and NOT-arity. Returns a discriminated result rather
 * than throwing. Mirrors the server-side validation in the RPC.
 */
export function validateRubricFilter(value: unknown): FilterValidationResult {
  const parsed = rubricFilterSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid filter" };
  }
  if (filterDepth(parsed.data) > MAX_FILTER_DEPTH) {
    return { ok: false, error: `Filter nesting too deep (max ${MAX_FILTER_DEPTH})` };
  }
  const arityErr = notArityError(parsed.data);
  if (arityErr) {
    return { ok: false, error: arityErr };
  }
  return { ok: true, value: parsed.data };
}
