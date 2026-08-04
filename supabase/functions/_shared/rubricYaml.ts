/**
 * Rubric row ↔ YAML ↔ `update_rubric_full` payload mapping.
 *
 * This module exists because the CLI's rubric export and import each maintained
 * their own hand-written field list, and both lists were missing the same seven
 * fields: `rubrics.hide_unless_assigned`, `rubric_parts.data`,
 * `.is_individual_grading`, `.is_assign_to_student`, `rubric_criteria.data`,
 * `rubric_checks.data`, and `.kpi_category`. An `export` → `import` round-trip
 * therefore downgraded per-student grading parts to regular grading, which collapses
 * every group member's grade to the shared total. Nothing failed; the numbers were
 * just wrong afterwards.
 *
 * One mapping, in one place, with a test that fails when a column is added and not
 * mapped, is the only thing that stops that recurring.
 *
 * Deliberately free of value imports — only `import type` from a `.d.ts` — so both
 * the Deno edge runtime and the Jest suite can load it. (Jest resolves
 * `supabase/functions/**` fine; what it rejects is a relative *value* import
 * carrying a `.ts` specifier.)
 */

// ── Enum values ─────────────────────────────────────────────────────────────
// Declared rather than imported: the generated `Constants` object lives in a
// `.d.ts`, so it is declaration-only and has no runtime value.

export const REVIEW_ROUNDS = ["self-review", "grading-review", "meta-grading-review", "code-walk"] as const;
export const STUDENT_VISIBILITIES = ["always", "if_released", "if_applied", "never"] as const;
export const KPI_CATEGORIES = [
  "issues_opened",
  "issues_closed",
  "issue_comments",
  "prs_opened",
  "pr_review_comments",
  "commits"
] as const;
export const ANNOTATION_TARGETS = ["file", "artifact"] as const;

export type ReviewRound = (typeof REVIEW_ROUNDS)[number];
export type StudentVisibility = (typeof STUDENT_VISIBILITIES)[number];
export type KpiCategory = (typeof KPI_CATEGORIES)[number];

// ── Structural row shapes ───────────────────────────────────────────────────
// Structural rather than derived from `Database` so fixtures can be built without
// the generated types.

export type JsonLike = unknown;

export interface YamlReferenceLike {
  review_round?: string;
  part?: string;
  criterion?: string;
  check?: string;
  id?: number;
}

export interface RubricCheckRowLike {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  points: number;
  is_annotation: boolean;
  is_comment_required: boolean;
  is_required: boolean;
  annotation_target: string | null;
  artifact: string | null;
  file: string | null;
  group: string | null;
  max_annotations: number | null;
  student_visibility: string;
  kpi_category: string | null;
  data: JsonLike;
}

export interface RubricCriteriaRowLike {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  total_points: number;
  is_additive: boolean;
  is_deduction_only: boolean;
  min_checks_per_submission: number | null;
  max_checks_per_submission: number | null;
  data: JsonLike;
  rubric_checks?: RubricCheckRowLike[];
}

export interface RubricPartRowLike {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  data: JsonLike;
  is_individual_grading: boolean;
  is_assign_to_student: boolean;
  rubric_criteria?: RubricCriteriaRowLike[];
}

export interface RubricTreeLike {
  id: number;
  name: string;
  description: string | null;
  is_private: boolean;
  review_round: string | null;
  cap_score_to_assignment_points: boolean;
  hide_unless_assigned: boolean;
  rubric_parts?: RubricPartRowLike[];
}

// ── YAML shape (the CLI's on-disk contract) ─────────────────────────────────
// Every field added here is optional, so YAML exported before this module existed
// still imports.

export interface RubricYamlCheck {
  id?: number;
  name: string;
  description?: string | null;
  ordinal?: number;
  points?: number;
  is_annotation?: boolean;
  is_comment_required?: boolean;
  is_required?: boolean;
  annotation_target?: string | null;
  artifact?: string | null;
  file?: string | null;
  group?: string | null;
  max_annotations?: number | null;
  student_visibility?: string;
  kpi_category?: string | null;
  data?: JsonLike;
  references?: YamlReferenceLike[];
}

export interface RubricYamlCriteria {
  id?: number;
  name: string;
  description?: string | null;
  ordinal?: number;
  total_points?: number;
  is_additive?: boolean;
  is_deduction_only?: boolean;
  min_checks_per_submission?: number | null;
  max_checks_per_submission?: number | null;
  data?: JsonLike;
  checks: RubricYamlCheck[];
}

export interface RubricYamlPart {
  id?: number;
  name: string;
  description?: string | null;
  ordinal?: number;
  data?: JsonLike;
  is_individual_grading?: boolean;
  is_assign_to_student?: boolean;
  criteria: RubricYamlCriteria[];
}

export interface RubricYamlSource {
  class_id: number;
  assignment_id: number;
  rubric_id: number;
  review_round: string | null;
  exported_at: string;
}

export interface RubricYaml {
  name: string;
  description?: string | null;
  is_private?: boolean;
  review_round?: string | null;
  cap_score_to_assignment_points?: boolean;
  hide_unless_assigned?: boolean;
  parts: RubricYamlPart[];
  _source?: RubricYamlSource;
}

/**
 * Fields accepted at each level of the rubric tree, kept beside the interfaces above so
 * the two are edited together.
 *
 * Unknown keys are rejected rather than ignored. A typo — `point` for `points`,
 * `is_indvidual_grading` for `is_individual_grading` — otherwise leaves the intended
 * field absent, and `buildUpdateRubricFullPayload` defaults an absent numeric to 0 and
 * an absent boolean to false. `update_rubric_full` then cascades that points change
 * into existing grading comments and recomputes scores, so a single misspelling silently
 * rewrites grades. Failing on the unrecognised key is the only way an operator finds out.
 */
const RUBRIC_YAML_KEYS = new Set([
  // Accepted and ignored. Exported documents carry the source rubric's id, but the
  // rubric being written is the one `--assignment` and `--type` resolve to, so
  // honouring it would let a file target a rubric the operator did not name.
  "id",
  "name",
  "description",
  "is_private",
  "review_round",
  "cap_score_to_assignment_points",
  "hide_unless_assigned",
  "parts",
  "_source"
]);

const PART_KEYS = new Set([
  "id",
  "name",
  "description",
  "ordinal",
  "data",
  "is_individual_grading",
  "is_assign_to_student",
  "criteria"
]);

const CRITERIA_KEYS = new Set([
  "id",
  "name",
  "description",
  "ordinal",
  "total_points",
  "is_additive",
  "is_deduction_only",
  "min_checks_per_submission",
  "max_checks_per_submission",
  "data",
  "checks"
]);

const CHECK_KEYS = new Set([
  "id",
  "name",
  "description",
  "ordinal",
  "points",
  "is_annotation",
  "is_comment_required",
  "is_required",
  "annotation_target",
  "artifact",
  "file",
  "group",
  "max_annotations",
  "student_visibility",
  "kpi_category",
  "data",
  "references"
]);

/** Records an error for each key not in `allowed`, naming the nearest known field. */
function checkNoUnknownKeys(
  row: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: YamlIssue[]
): void {
  for (const key of Object.keys(row)) {
    if (allowed.has(key)) continue;
    const suggestion = nearestKey(key, allowed);
    errors.push({
      path: `${path}.${key}`,
      message:
        `unknown field "${key}"` +
        (suggestion ? `; did you mean "${suggestion}"?` : "") +
        ". Unknown fields are rejected because the field you meant would be treated as " +
        "absent, and an absent points value defaults to 0."
    });
  }
}

/**
 * The allowed key closest to `key` by edit distance, when one is close enough to be a
 * plausible typo. Cheap on purpose: these sets have at most 17 entries.
 */
function nearestKey(key: string, allowed: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Two edits on a short name is still recognisable; beyond that a guess misleads.
  return best !== null && bestDistance <= Math.max(2, Math.floor(best.length / 4)) ? best : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

// ── update_rubric_full payload ──────────────────────────────────────────────

export interface PayloadCheck {
  id?: number;
  name: string;
  description: string | null;
  ordinal: number;
  data: JsonLike;
  file: string | null;
  artifact: string | null;
  group: string | null;
  is_annotation: boolean;
  is_comment_required: boolean;
  is_required: boolean;
  max_annotations: number | null;
  points: number;
  annotation_target: string | null;
  student_visibility: StudentVisibility;
  kpi_category: string | null;
  references: Array<{ referenced_rubric_check_id: number }>;
}

export interface PayloadCriteria {
  id?: number;
  name: string;
  description: string | null;
  ordinal: number;
  data: JsonLike;
  is_additive: boolean;
  is_deduction_only: boolean;
  total_points: number;
  max_checks_per_submission: number | null;
  min_checks_per_submission: number | null;
  checks: PayloadCheck[];
}

export interface PayloadPart {
  id?: number;
  name: string;
  description: string | null;
  ordinal: number;
  data: JsonLike;
  is_individual_grading: boolean;
  is_assign_to_student: boolean;
  criteria: PayloadCriteria[];
}

export interface UpdateRubricFullPayload {
  id: number;
  class_id: number;
  assignment_id: number;
  review_round: string | null;
  name: string;
  description: string | null;
  is_private: boolean;
  cap_score_to_assignment_points: boolean;
  hide_unless_assigned: boolean;
  parts: PayloadPart[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Stable key for a check's position in the tree, used to carry resolved references. */
export function rubricPathKey(partIdx: number, critIdx: number, checkIdx: number): string {
  return `${partIdx}:${critIdx}:${checkIdx}`;
}

function nullIfUndefined<T>(value: T | undefined | null): T | null {
  return value === undefined || value === null ? null : value;
}

/** A positive integer id, or undefined so the RPC treats the row as new. */
function optionalId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Whether an `id` field is present but not a usable id — `id: "123"`, `id: 123.5`,
 * `id: 0`, `id: null`.
 *
 * `optionalId` folds those into "absent", which is not harmless: import then treats the
 * row as new and deletes the row whose id the operator was trying to preserve, taking
 * its grading comments with it on an ungraded rubric and failing the whole import on a
 * graded one. Validation rejects them instead, so a typo cannot silently change row
 * identity.
 */
function isMalformedId(value: unknown): boolean {
  if (value === undefined) return false;
  return optionalId(value) === undefined;
}

/** Records an error when an `id` field is present but unusable. */
function checkOptionalId(value: unknown, path: string, errors: YamlIssue[]): void {
  if (!isMalformedId(value)) return;
  errors.push({
    path: `${path}.id`,
    message:
      `id must be a positive integer naming an existing row (got ${JSON.stringify(value)}). ` +
      "Omit id entirely to create the row as new."
  });
}

function byOrdinal<T extends { ordinal: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.ordinal - b.ordinal);
}

// ── Export: row tree → YAML ─────────────────────────────────────────────────

/**
 * Serializes a hydrated rubric to the CLI's YAML shape.
 *
 * Children are sorted by `ordinal`, matching `lib/rubric/serialize.ts`. The previous
 * implementation relied on whatever order the PostgREST embed returned, which is
 * unspecified — so array order and the explicit `ordinal` values could disagree.
 *
 * `id` is emitted at part, criteria, and check level. That is what lets an
 * export → edit → import round-trip preserve check identity, so existing grading
 * comments stay attached instead of being deleted and re-created.
 */
export function rubricTreeToYaml(
  tree: RubricTreeLike,
  referencesByCheckId: ReadonlyMap<number, YamlReferenceLike[]>,
  source: RubricYamlSource
): RubricYaml {
  return {
    name: tree.name,
    description: tree.description,
    is_private: tree.is_private,
    review_round: tree.review_round,
    cap_score_to_assignment_points: tree.cap_score_to_assignment_points,
    hide_unless_assigned: tree.hide_unless_assigned,
    _source: source,
    parts: byOrdinal(tree.rubric_parts ?? []).map((part) => ({
      id: part.id,
      name: part.name,
      description: part.description,
      ordinal: part.ordinal,
      data: part.data ?? null,
      // Emitted explicitly rather than omitted-when-false the way the web
      // serializer does. This file is also a human-readable artifact, and the flag
      // whose absence collapsed group grades should be visible in it.
      is_individual_grading: part.is_individual_grading,
      is_assign_to_student: part.is_assign_to_student,
      criteria: byOrdinal(part.rubric_criteria ?? []).map((criteria) => ({
        id: criteria.id,
        name: criteria.name,
        description: criteria.description,
        ordinal: criteria.ordinal,
        data: criteria.data ?? null,
        total_points: criteria.total_points,
        is_additive: criteria.is_additive,
        is_deduction_only: criteria.is_deduction_only,
        min_checks_per_submission: criteria.min_checks_per_submission,
        max_checks_per_submission: criteria.max_checks_per_submission,
        checks: byOrdinal(criteria.rubric_checks ?? []).map((check) => {
          const refs = referencesByCheckId.get(check.id);
          const out: RubricYamlCheck = {
            id: check.id,
            name: check.name,
            description: check.description,
            ordinal: check.ordinal,
            points: check.points,
            is_annotation: check.is_annotation,
            is_comment_required: check.is_comment_required,
            is_required: check.is_required,
            annotation_target: check.annotation_target,
            artifact: check.artifact,
            file: check.file,
            group: check.group,
            max_annotations: check.max_annotations,
            student_visibility: check.student_visibility,
            kpi_category: check.kpi_category,
            data: check.data ?? null
          };
          if (refs && refs.length > 0) out.references = refs;
          return out;
        })
      }))
    }))
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface YamlIssue {
  path: string;
  message: string;
}

export type ValidateResult =
  | { ok: true; value: RubricYaml; warnings: YamlIssue[] }
  | { ok: false; errors: YamlIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkInteger(value: unknown, path: string, field: string, errors: YamlIssue[], reason: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push({ path: `${path}.${field}`, message: `${String(value)} is not an integer; ${reason}` });
  }
}

/**
 * Rejects a non-boolean where a boolean belongs.
 *
 * The parser follows YAML 1.2, where only `true`/`false` (any capitalization) are
 * booleans — the YAML 1.1 spellings `yes`, `no`, `on`, `off` parse as *strings*. Nothing
 * else checked these, so `is_individual_grading: yes` sailed past the `=== true`
 * exclusivity guard below, was forwarded verbatim, and Postgres then cast `'yes'` to
 * true for both mutually exclusive columns — surfacing as a raw check-constraint
 * violation under HTTP 500 rather than the validation message this function exists to
 * produce. `is_annotation: maybe` was worse: an outright 22P02 cast error.
 */
function checkBoolean(value: unknown, path: string, field: string, errors: YamlIssue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "boolean") {
    errors.push({
      path: `${path}.${field}`,
      message: `${String(value)} is not a boolean; write true or false (YAML 1.1 spellings like yes/no/on/off are read as text)`
    });
  }
}

/**
 * Validates a parsed YAML document, collecting **every** problem rather than
 * throwing on the first.
 *
 * This is the half of the import that used to be missing entirely: enums were
 * type-cast rather than checked, so a typo'd `student_visibility` surfaced as a
 * Postgres cast error — and, in the old delete-then-insert implementation, only
 * after the live rubric had already been deleted.
 */
export function validateRubricYaml(input: unknown): ValidateResult {
  const errors: YamlIssue[] = [];
  const warnings: YamlIssue[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "", message: "rubric must be an object" }] };
  }

  checkNoUnknownKeys(input, RUBRIC_YAML_KEYS, "rubric", errors);

  const name = input.name;
  if (typeof name !== "string" || name.trim() === "") {
    errors.push({ path: "name", message: "rubric name is required" });
  }

  checkBoolean(input.is_private, "rubric", "is_private", errors);
  checkBoolean(input.cap_score_to_assignment_points, "rubric", "cap_score_to_assignment_points", errors);
  checkBoolean(input.hide_unless_assigned, "rubric", "hide_unless_assigned", errors);

  if (input.review_round !== undefined && input.review_round !== null) {
    if (!(REVIEW_ROUNDS as readonly string[]).includes(String(input.review_round))) {
      errors.push({
        path: "review_round",
        message: `${String(input.review_round)} is not a review round (${REVIEW_ROUNDS.join(", ")})`
      });
    }
  }

  if (!Array.isArray(input.parts)) {
    errors.push({ path: "parts", message: "parts must be an array" });
    return { ok: false, errors };
  }
  if (input.parts.length === 0) {
    // Legal input, but on a rubric that currently has parts it removes all of them —
    // so it must be a deliberate act, surfaced by the plan rather than silent.
    warnings.push({ path: "parts", message: "parts is empty; every existing part will be removed" });
  }

  // Rubric-scoped, not per-parent. `update_rubric_full` keys rows by id, so the same
  // criteria id under two parts (or the same check id under two criteria) is one
  // database row updated and moved twice, ending up attached only to whichever parent
  // was processed last while children from both YAML locations were applied to it.
  const seenPartIds = new Set<number>();
  const seenCriteriaIds = new Set<number>();
  const seenCheckIds = new Set<number>();
  input.parts.forEach((rawPart, partIdx) => {
    const partPath = `parts[${partIdx}]`;
    if (!isPlainObject(rawPart)) {
      errors.push({ path: partPath, message: "part must be an object" });
      return;
    }
    if (typeof rawPart.name !== "string" || rawPart.name.trim() === "") {
      errors.push({ path: `${partPath}.name`, message: "part name is required" });
    }
    checkNoUnknownKeys(rawPart, PART_KEYS, partPath, errors);
    checkBoolean(rawPart.is_individual_grading, partPath, "is_individual_grading", errors);
    checkBoolean(rawPart.is_assign_to_student, partPath, "is_assign_to_student", errors);
    checkOptionalId(rawPart.id, partPath, errors);
    const partId = optionalId(rawPart.id);
    if (partId !== undefined) {
      if (seenPartIds.has(partId)) {
        errors.push({
          path: `${partPath}.id`,
          message: `duplicate part id ${partId}; remove the id from the copy so it is created as new`
        });
      }
      seenPartIds.add(partId);
    }
    if (rawPart.is_individual_grading === true && rawPart.is_assign_to_student === true) {
      errors.push({
        path: partPath,
        message: "is_individual_grading and is_assign_to_student are mutually exclusive"
      });
    }

    if (!Array.isArray(rawPart.criteria)) {
      errors.push({ path: `${partPath}.criteria`, message: "criteria must be an array" });
      return;
    }

    rawPart.criteria.forEach((rawCriteria, critIdx) => {
      const critPath = `${partPath}.criteria[${critIdx}]`;
      if (!isPlainObject(rawCriteria)) {
        errors.push({ path: critPath, message: "criteria must be an object" });
        return;
      }
      if (typeof rawCriteria.name !== "string" || rawCriteria.name.trim() === "") {
        errors.push({ path: `${critPath}.name`, message: "criteria name is required" });
      }
      checkNoUnknownKeys(rawCriteria, CRITERIA_KEYS, critPath, errors);
      checkOptionalId(rawCriteria.id, critPath, errors);
      const critId = optionalId(rawCriteria.id);
      if (critId !== undefined) {
        if (seenCriteriaIds.has(critId)) {
          errors.push({
            path: `${critPath}.id`,
            message: `duplicate criteria id ${critId} in this document; remove the id from the copy so it is created as new`
          });
        }
        seenCriteriaIds.add(critId);
      }
      checkBoolean(rawCriteria.is_additive, critPath, "is_additive", errors);
      checkBoolean(rawCriteria.is_deduction_only, critPath, "is_deduction_only", errors);
      checkInteger(rawCriteria.total_points, critPath, "total_points", errors, "total_points is stored as an integer");
      checkInteger(
        rawCriteria.min_checks_per_submission,
        critPath,
        "min_checks_per_submission",
        errors,
        "it is stored as an integer"
      );
      checkInteger(
        rawCriteria.max_checks_per_submission,
        critPath,
        "max_checks_per_submission",
        errors,
        "it is stored as an integer"
      );

      if (!Array.isArray(rawCriteria.checks)) {
        errors.push({ path: `${critPath}.checks`, message: "checks must be an array" });
        return;
      }

      rawCriteria.checks.forEach((rawCheck, checkIdx) => {
        const checkPath = `${critPath}.checks[${checkIdx}]`;
        if (!isPlainObject(rawCheck)) {
          errors.push({ path: checkPath, message: "check must be an object" });
          return;
        }
        if (typeof rawCheck.name !== "string" || rawCheck.name.trim() === "") {
          errors.push({ path: `${checkPath}.name`, message: "check name is required" });
        }
        checkNoUnknownKeys(rawCheck, CHECK_KEYS, checkPath, errors);
        checkOptionalId(rawCheck.id, checkPath, errors);
        const checkId = optionalId(rawCheck.id);
        if (checkId !== undefined) {
          if (seenCheckIds.has(checkId)) {
            errors.push({ path: `${checkPath}.id`, message: `duplicate check id ${checkId}` });
          }
          seenCheckIds.add(checkId);
        }

        checkBoolean(rawCheck.is_annotation, checkPath, "is_annotation", errors);
        checkBoolean(rawCheck.is_comment_required, checkPath, "is_comment_required", errors);
        checkBoolean(rawCheck.is_required, checkPath, "is_required", errors);
        checkInteger(rawCheck.max_annotations, checkPath, "max_annotations", errors, "it is stored as an integer");

        // Guarded like `criteria` and `checks` are. The importer does
        // `for (const ref of check.references ?? [])`, so `references: 5` skipped the
        // length check and threw a TypeError — a 500 where the operator should have got
        // this function's 400 list — and a string iterated per character, silently
        // degrading to "reference dropped" warnings.
        if (rawCheck.references !== undefined && rawCheck.references !== null) {
          if (!Array.isArray(rawCheck.references)) {
            errors.push({ path: `${checkPath}.references`, message: "references must be an array" });
          } else {
            rawCheck.references.forEach((rawRef, refIdx) => {
              if (!isPlainObject(rawRef)) {
                errors.push({
                  path: `${checkPath}.references[${refIdx}]`,
                  message: "reference must be an object with review_round/part/criterion/check, or id"
                });
              }
            });
          }
        }

        if (rawCheck.points !== undefined && rawCheck.points !== null) {
          // Number.isFinite, not just !isNaN: YAML has literal forms for infinity
          // (`.inf`, and any overflowing literal such as `1e999`). JSON has no way to
          // carry Infinity, so it serializes to null on the way here, and an absent
          // points value defaults to 0 — which update_rubric_full then cascades into
          // existing grading comments. The CLI rejects these before serializing; this
          // is the second line of defense for any other caller.
          if (typeof rawCheck.points !== "number" || !Number.isFinite(rawCheck.points)) {
            errors.push({
              path: `${checkPath}.points`,
              message: `${String(rawCheck.points)} is not a finite number`
            });
          } else if (rawCheck.points < 0) {
            // Not silently made positive the way the web's sanitizer does: quietly
            // turning -3 into 3 on a graded rubric would cascade to every existing
            // comment.
            errors.push({
              path: `${checkPath}.points`,
              message: `${rawCheck.points} is negative; fix the value rather than relying on it being made positive`
            });
          }
        }

        if (rawCheck.student_visibility !== undefined && rawCheck.student_visibility !== null) {
          if (!(STUDENT_VISIBILITIES as readonly string[]).includes(String(rawCheck.student_visibility))) {
            errors.push({
              path: `${checkPath}.student_visibility`,
              message: `${String(rawCheck.student_visibility)} is not valid (${STUDENT_VISIBILITIES.join(", ")})`
            });
          }
        }

        if (rawCheck.kpi_category !== undefined && rawCheck.kpi_category !== null) {
          if (!(KPI_CATEGORIES as readonly string[]).includes(String(rawCheck.kpi_category))) {
            errors.push({
              path: `${checkPath}.kpi_category`,
              message: `${String(rawCheck.kpi_category)} is not valid (${KPI_CATEGORIES.join(", ")})`
            });
          }
        }

        if (rawCheck.annotation_target !== undefined && rawCheck.annotation_target !== null) {
          if (!(ANNOTATION_TARGETS as readonly string[]).includes(String(rawCheck.annotation_target))) {
            errors.push({
              path: `${checkPath}.annotation_target`,
              message: `${String(rawCheck.annotation_target)} is not valid (${ANNOTATION_TARGETS.join(", ")})`
            });
          }
        }
      });
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as RubricYaml, warnings };
}

// ── Payload assembly ────────────────────────────────────────────────────────

export interface BuildPayloadArgs {
  yaml: RubricYaml;
  rubricId: number;
  classId: number;
  assignmentId: number;
  /** Authoritative, from the DB row — never the YAML's. */
  reviewRound: string | null;
  /** Current values, carried forward when the YAML omits the key. */
  existing: Pick<RubricTreeLike, "cap_score_to_assignment_points" | "is_private" | "hide_unless_assigned">;
  /** rubricPathKey → resolved referenced check ids. */
  resolvedRefsByPath: ReadonlyMap<string, number[]>;
}

/**
 * Builds the `update_rubric_full` payload.
 *
 * Two defaulting rules matter here:
 *
 *  - The three rubric-level flags are **tri-state**: absent means "not specified",
 *    so the current DB value is carried forward. The old import defaulted
 *    `cap_score_to_assignment_points` to `true` while the web and the RPC default it
 *    to `false`, and the RPC's own `COALESCE(..., false)` would flip a private rubric
 *    public if we let an absent key through. Sending the resolved value explicitly on
 *    every call means neither can happen.
 *  - Row-level booleans default to `false`, matching the web and the RPC. The old
 *    import defaulted `is_additive` to `true`, which silently changed criteria
 *    behavior on import.
 *
 * `ordinal` comes from array position, which is what the web uses and what a human
 * editing YAML actually manipulates.
 */
export function buildUpdateRubricFullPayload(args: BuildPayloadArgs): UpdateRubricFullPayload {
  const { yaml, existing } = args;

  return {
    id: args.rubricId,
    class_id: args.classId,
    assignment_id: args.assignmentId,
    review_round: args.reviewRound,
    name: yaml.name,
    description: nullIfUndefined(yaml.description),
    is_private: yaml.is_private ?? existing.is_private,
    cap_score_to_assignment_points: yaml.cap_score_to_assignment_points ?? existing.cap_score_to_assignment_points,
    hide_unless_assigned: yaml.hide_unless_assigned ?? existing.hide_unless_assigned,
    parts: yaml.parts.map((part, partIdx) => ({
      id: optionalId(part.id),
      name: part.name,
      description: nullIfUndefined(part.description),
      ordinal: partIdx,
      data: part.data ?? null,
      is_individual_grading: part.is_individual_grading ?? false,
      is_assign_to_student: part.is_assign_to_student ?? false,
      criteria: part.criteria.map((criteria, critIdx) => ({
        id: optionalId(criteria.id),
        name: criteria.name,
        description: nullIfUndefined(criteria.description),
        ordinal: critIdx,
        data: criteria.data ?? null,
        is_additive: criteria.is_additive ?? false,
        is_deduction_only: criteria.is_deduction_only ?? false,
        total_points: criteria.total_points ?? 0,
        max_checks_per_submission: nullIfUndefined(criteria.max_checks_per_submission),
        min_checks_per_submission: nullIfUndefined(criteria.min_checks_per_submission),
        checks: criteria.checks.map((check, checkIdx) => ({
          id: optionalId(check.id),
          name: check.name,
          description: nullIfUndefined(check.description),
          ordinal: checkIdx,
          data: check.data ?? null,
          file: nullIfUndefined(check.file),
          artifact: nullIfUndefined(check.artifact),
          group: nullIfUndefined(check.group),
          is_annotation: check.is_annotation ?? false,
          is_comment_required: check.is_comment_required ?? false,
          is_required: check.is_required ?? false,
          max_annotations: nullIfUndefined(check.max_annotations),
          points: check.points ?? 0,
          annotation_target: nullIfUndefined(check.annotation_target),
          student_visibility: (check.student_visibility ?? "always") as StudentVisibility,
          kpi_category: nullIfUndefined(check.kpi_category),
          references: (args.resolvedRefsByPath.get(rubricPathKey(partIdx, critIdx, checkIdx)) ?? []).map((id) => ({
            referenced_rubric_check_id: id
          }))
        }))
      }))
    }))
  };
}

// ── Diff plan (for --dry-run) ───────────────────────────────────────────────

export interface RubricImportPlan {
  parts: { insert: string[]; update: number[]; remove: Array<{ id: number; name: string }> };
  criteria: { insert: string[]; update: number[]; remove: Array<{ id: number; name: string }> };
  checks: {
    insert: string[];
    update: number[];
    remove: Array<{ id: number; name: string }>;
    points_changed: Array<{ id: number; name: string; from: number; to: number }>;
  };
  /**
   * Criteria whose scoring changed (`total_points`, `is_additive`, `is_deduction_only`).
   * Tracked separately from `criteria.update` because the RPC treats exactly these three
   * columns as a broad change, and nothing else about a criterion update does.
   */
  criteria_scoring_changed: Array<{ id: number; name: string }>;
  /** Ids in the YAML that this rubric does not own — the copy/paste-YAML case. */
  foreign_ids: Array<{ level: "part" | "criterion" | "check"; id: number; name: string }>;
  broad_change: boolean;
}

/**
 * Predicts what `update_rubric_full` will do, so `--dry-run` can report it.
 *
 * Mirrors the RPC's rules: a positive id that this rubric owns is an update,
 * anything else is an insert (and, if positive, a foreign id), and rows the payload
 * does not mention are removed. Kept in step with
 * `supabase/migrations/…_update_rubric_full_numeric_points_and_timeout.sql` — if that
 * function's diff rules change, this must too, or the dry run starts lying.
 */
export function planRubricImport(current: RubricTreeLike, payload: UpdateRubricFullPayload): RubricImportPlan {
  const plan: RubricImportPlan = {
    parts: { insert: [], update: [], remove: [] },
    criteria: { insert: [], update: [], remove: [] },
    checks: { insert: [], update: [], remove: [], points_changed: [] },
    criteria_scoring_changed: [],
    foreign_ids: [],
    broad_change: false
  };

  const ownedParts = new Map<number, RubricPartRowLike>();
  const ownedCriteria = new Map<number, RubricCriteriaRowLike>();
  const ownedChecks = new Map<number, RubricCheckRowLike>();
  for (const part of current.rubric_parts ?? []) {
    ownedParts.set(part.id, part);
    for (const criteria of part.rubric_criteria ?? []) {
      ownedCriteria.set(criteria.id, criteria);
      for (const check of criteria.rubric_checks ?? []) ownedChecks.set(check.id, check);
    }
  }

  const seenParts = new Set<number>();
  const seenCriteria = new Set<number>();
  const seenChecks = new Set<number>();
  /** An existing criterion's total_points / is_additive / is_deduction_only changed. */

  for (const part of payload.parts) {
    if (part.id !== undefined && ownedParts.has(part.id)) {
      plan.parts.update.push(part.id);
      seenParts.add(part.id);
    } else {
      plan.parts.insert.push(part.name);
      if (part.id !== undefined) plan.foreign_ids.push({ level: "part", id: part.id, name: part.name });
    }

    for (const criteria of part.criteria) {
      if (criteria.id !== undefined && ownedCriteria.has(criteria.id)) {
        plan.criteria.update.push(criteria.id);
        seenCriteria.add(criteria.id);
        // These three are the RPC's criterion-level broad-change triggers (migration
        // lines 332-336). Omitting them let a one-line `total_points` or `is_additive`
        // edit report "No structural changes" and then recompute every submission_review
        // on the rubric — the most expensive and most grade-visible thing an import does.
        const beforeCriteria = ownedCriteria.get(criteria.id)!;
        if (
          beforeCriteria.total_points !== criteria.total_points ||
          beforeCriteria.is_additive !== criteria.is_additive ||
          beforeCriteria.is_deduction_only !== criteria.is_deduction_only
        ) {
          plan.criteria_scoring_changed.push({ id: criteria.id, name: criteria.name });
        }
      } else {
        plan.criteria.insert.push(criteria.name);
        if (criteria.id !== undefined) {
          plan.foreign_ids.push({ level: "criterion", id: criteria.id, name: criteria.name });
        }
      }

      for (const check of criteria.checks) {
        if (check.id !== undefined && ownedChecks.has(check.id)) {
          plan.checks.update.push(check.id);
          seenChecks.add(check.id);
          const before = ownedChecks.get(check.id)!;
          if (before.points !== check.points) {
            plan.checks.points_changed.push({
              id: check.id,
              name: check.name,
              from: before.points,
              to: check.points
            });
          }
        } else {
          plan.checks.insert.push(check.name);
          if (check.id !== undefined) {
            plan.foreign_ids.push({ level: "check", id: check.id, name: check.name });
          }
        }
      }
    }
  }

  for (const [id, part] of ownedParts) {
    if (!seenParts.has(id)) plan.parts.remove.push({ id, name: part.name });
  }
  for (const [id, criteria] of ownedCriteria) {
    if (!seenCriteria.has(id)) plan.criteria.remove.push({ id, name: criteria.name });
  }
  for (const [id, check] of ownedChecks) {
    if (!seenChecks.has(id)) plan.checks.remove.push({ id, name: check.name });
  }

  plan.broad_change =
    plan.parts.insert.length > 0 ||
    plan.parts.remove.length > 0 ||
    plan.criteria.insert.length > 0 ||
    plan.criteria.remove.length > 0 ||
    plan.checks.insert.length > 0 ||
    plan.checks.remove.length > 0 ||
    plan.checks.points_changed.length > 0 ||
    plan.criteria_scoring_changed.length > 0 ||
    current.cap_score_to_assignment_points !== payload.cap_score_to_assignment_points;

  return plan;
}
