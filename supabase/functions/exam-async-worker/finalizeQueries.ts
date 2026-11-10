/**
 * Query shapes `finalize` depends on, in a plain-TS module so the Deno worker and the Jest
 * integration test import the SAME string instead of each keeping a copy.
 *
 * The first version of the #1075 regression test declared its own copy of the select below
 * with a "keep in sync" comment. That test passed against a reverted worker, because nothing
 * tied the two strings together -- it proved PostgREST accepts this select, not that finalize
 * uses it. Exporting it from here is what makes the test fail when the fix is undone.
 */

/**
 * The answer-region select in `finalize`.
 *
 * `exam_questions` has to be reached by an explicitly named foreign key: two FKs connect it to
 * `exam_question_regions` -- the single-column `exam_question_regions_exam_question_id_fkey`
 * and the composite `exam_question_regions_question_exam_fkey`. PostgREST cannot choose between
 * them and fails the whole query with PGRST201 (#1075), which left every scan batch stuck in
 * `finalizing`. The composite one is named here because it also checks that the region and the
 * question belong to the same exam.
 */
export const FINALIZE_ANSWER_REGION_SELECT =
  "exam_question_id, page_number, x, y, width, height, exam_questions!exam_question_regions_question_exam_fkey(answer_type)";
