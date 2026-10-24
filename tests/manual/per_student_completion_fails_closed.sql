-- Proof harness for 20260811130100_per_student_completion_fails_closed.sql.
--
-- Run from the repo root against local Supabase; everything happens in one transaction that ends in
-- ROLLBACK, so it leaves no fixtures behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/per_student_completion_fails_closed.sql
--
-- It measures the OLD behavior first, then applies the migration inside the same transaction and
-- measures again, so both columns come from one run.
--
-- Scenarios (all on an is_individual_grading rubric part with a required check and a criterion whose
-- min_checks_per_submission = 1):
--   A. group submission whose assignment_groups_members is empty, one comment on the check
--   B. group with 2 members, a comment targeting each          -> must stay completable
--   C. group with 2 members, a comment targeting only one      -> must stay reported missing
--   D. empty group, required check on a rubric part that NO review assignment covers -> exercises
--      check_and_complete_submission_review and the *_for_uncovered helpers
--   E. same as D but with 2 members, both commented            -> must still auto-complete

\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE harness_results (
  ord serial,
  phase text,
  scenario text,
  measurement text,
  value text
) ON COMMIT DROP;

-- ---------------------------------------------------------------------------------------------
-- Fixtures. Hangs off existing class 1 / assignment 1 so we do not have to satisfy every NOT NULL
-- on classes and assignments; nothing existing is modified.
-- ---------------------------------------------------------------------------------------------
CREATE TEMP TABLE fx (k text primary key, v text) ON COMMIT DROP;

DO $fixtures$
DECLARE
  v_class_id bigint := 1;
  v_assignment_id bigint := 1;
  v_grader uuid;
  v_stu1 uuid;
  v_stu2 uuid;
  v_stu3 uuid;
  v_stu4 uuid;
  v_stu5 uuid;
  v_stu6 uuid;
  v_students uuid[];
  v_rubric_id bigint;
  v_part_shared bigint;
  v_part_indiv bigint;
  v_crit_shared bigint;
  v_crit_indiv bigint;
  v_check_shared bigint;
  v_check_indiv bigint;
BEGIN
  -- Reuse seeded roster rows: assignment_groups_members.profile_id has an FK to
  -- user_roles.private_profile_id, so members must be real enrolled students.
  SELECT ur.private_profile_id INTO v_grader
  FROM public.user_roles ur
  WHERE ur.class_id = v_class_id AND ur.role = 'instructor'
  ORDER BY ur.private_profile_id
  LIMIT 1;

  SELECT array_agg(private_profile_id ORDER BY private_profile_id)
  INTO v_students
  FROM (
    SELECT ur.private_profile_id
    FROM public.user_roles ur
    WHERE ur.class_id = v_class_id AND ur.role = 'student' AND ur.disabled = false
    ORDER BY ur.private_profile_id
    LIMIT 6
  ) s;

  IF v_grader IS NULL OR COALESCE(array_length(v_students, 1), 0) < 6 THEN
    RAISE EXCEPTION 'harness needs class % to have 1 instructor and 6 enrolled students; run npm run seed',
      v_class_id;
  END IF;

  -- assignment_groups_members is UNIQUE (assignment_id, profile_id), so every scenario group needs
  -- its own students.
  v_stu1 := v_students[1];
  v_stu2 := v_students[2];
  v_stu3 := v_students[3];
  v_stu4 := v_students[4];
  v_stu5 := v_students[5];
  v_stu6 := v_students[6];

  INSERT INTO public.rubrics (name, class_id, assignment_id, review_round)
  VALUES ('Harness per-student rubric', v_class_id, v_assignment_id, 'grading-review')
  RETURNING id INTO v_rubric_id;

  -- Part graded once for the whole submission (used as the "covered" part in scenarios D/E).
  INSERT INTO public.rubric_parts (class_id, rubric_id, name, ordinal, assignment_id, is_individual_grading)
  VALUES (v_class_id, v_rubric_id, 'Shared part', 1, v_assignment_id, false)
  RETURNING id INTO v_part_shared;

  -- Part graded per student. This is the one whose zero-target fallthrough was fail-dangerous.
  INSERT INTO public.rubric_parts (class_id, rubric_id, name, ordinal, assignment_id, is_individual_grading)
  VALUES (v_class_id, v_rubric_id, 'Per-student part', 2, v_assignment_id, true)
  RETURNING id INTO v_part_indiv;

  INSERT INTO public.rubric_criteria
    (rubric_id, name, total_points, is_additive, class_id, rubric_part_id, assignment_id, ordinal)
  VALUES (v_rubric_id, 'Shared criteria', 10, true, v_class_id, v_part_shared, v_assignment_id, 1)
  RETURNING id INTO v_crit_shared;

  INSERT INTO public.rubric_criteria
    (rubric_id, name, total_points, is_additive, class_id, rubric_part_id, assignment_id, ordinal,
     min_checks_per_submission)
  VALUES (v_rubric_id, 'Per-student criteria', 10, true, v_class_id, v_part_indiv, v_assignment_id, 2, 1)
  RETURNING id INTO v_crit_indiv;

  INSERT INTO public.rubric_checks
    (rubric_criteria_id, name, ordinal, is_annotation, points, class_id, is_required, assignment_id, rubric_id)
  VALUES (v_crit_shared, 'Shared required check', 1, false, 5, v_class_id, true, v_assignment_id, v_rubric_id)
  RETURNING id INTO v_check_shared;

  INSERT INTO public.rubric_checks
    (rubric_criteria_id, name, ordinal, is_annotation, points, class_id, is_required, assignment_id, rubric_id)
  VALUES (v_crit_indiv, 'Per-student required check', 2, false, 5, v_class_id, true, v_assignment_id, v_rubric_id)
  RETURNING id INTO v_check_indiv;

  INSERT INTO fx VALUES
    ('class_id', v_class_id::text), ('assignment_id', v_assignment_id::text),
    ('grader', v_grader::text), ('stu1', v_stu1::text), ('stu2', v_stu2::text),
    ('stu3', v_stu3::text), ('stu4', v_stu4::text),
    ('stu5', v_stu5::text), ('stu6', v_stu6::text),
    ('rubric_id', v_rubric_id::text),
    ('part_shared', v_part_shared::text), ('part_indiv', v_part_indiv::text),
    ('crit_indiv', v_crit_indiv::text),
    ('check_shared', v_check_shared::text), ('check_indiv', v_check_indiv::text);
END
$fixtures$;

-- Builds one scenario: a group (with the given members), an active submission, its grading review,
-- a review assignment (optionally scoped to the shared part only), and comments on the required
-- checks for the given target students.
CREATE OR REPLACE FUNCTION pg_temp.mk_scenario(
  p_label text,
  p_member_profile_ids uuid[],
  p_commented_target_ids uuid[],
  p_scope_to_shared_part boolean,
  p_comment_indiv_untargeted boolean
) RETURNS void
LANGUAGE plpgsql
AS $mk$
DECLARE
  v_class_id bigint := (SELECT v::bigint FROM fx WHERE k = 'class_id');
  v_assignment_id bigint := (SELECT v::bigint FROM fx WHERE k = 'assignment_id');
  v_grader uuid := (SELECT v::uuid FROM fx WHERE k = 'grader');
  v_rubric_id bigint := (SELECT v::bigint FROM fx WHERE k = 'rubric_id');
  v_part_shared bigint := (SELECT v::bigint FROM fx WHERE k = 'part_shared');
  v_check_shared bigint := (SELECT v::bigint FROM fx WHERE k = 'check_shared');
  v_check_indiv bigint := (SELECT v::bigint FROM fx WHERE k = 'check_indiv');
  v_group_id bigint;
  v_submission_id bigint;
  v_review_id bigint;
  v_ra_id bigint;
  v_member uuid;
  v_target uuid;
BEGIN
  INSERT INTO public.assignment_groups (name, class_id, assignment_id)
  VALUES ('Harness group ' || p_label, v_class_id, v_assignment_id)
  RETURNING id INTO v_group_id;

  FOREACH v_member IN ARRAY COALESCE(p_member_profile_ids, ARRAY[]::uuid[]) LOOP
    INSERT INTO public.assignment_groups_members
      (assignment_group_id, profile_id, class_id, assignment_id, added_by)
    VALUES (v_group_id, v_member, v_class_id, v_assignment_id, v_grader);
  END LOOP;

  INSERT INTO public.submissions
    (assignment_id, class_id, assignment_group_id, run_attempt, run_number, is_active, ordinal)
  VALUES (v_assignment_id, v_class_id, v_group_id, 1, 1, true, 1)
  RETURNING id INTO v_submission_id;

  INSERT INTO public.submission_reviews
    (total_score, tweak, class_id, submission_id, name, rubric_id, grader)
  VALUES (0, 0, v_class_id, v_submission_id, 'Harness review ' || p_label, v_rubric_id, v_grader)
  RETURNING id INTO v_review_id;

  UPDATE public.submissions SET grading_review_id = v_review_id WHERE id = v_submission_id;

  INSERT INTO public.review_assignments
    (due_date, assignee_profile_id, submission_id, assignment_id, rubric_id, class_id, submission_review_id)
  VALUES (now() + interval '7 days', v_grader, v_submission_id, v_assignment_id, v_rubric_id,
          v_class_id, v_review_id)
  RETURNING id INTO v_ra_id;

  IF p_scope_to_shared_part THEN
    INSERT INTO public.review_assignment_rubric_parts (review_assignment_id, rubric_part_id, class_id)
    VALUES (v_ra_id, v_part_shared, v_class_id);
  END IF;

  -- Shared required check always satisfied, so it never confuses the assertions.
  INSERT INTO public.submission_comments
    (submission_id, author, comment, class_id, rubric_check_id, submission_review_id, points)
  VALUES (v_submission_id, v_grader, 'shared', v_class_id, v_check_shared, v_review_id, 5);

  -- One comment on the per-student check for each target we were told to grade.
  FOREACH v_target IN ARRAY COALESCE(p_commented_target_ids, ARRAY[]::uuid[]) LOOP
    INSERT INTO public.submission_comments
      (submission_id, author, comment, class_id, rubric_check_id, submission_review_id, points,
       target_student_profile_id)
    VALUES (v_submission_id, v_grader, 'per-student for ' || v_target, v_class_id, v_check_indiv,
            v_review_id, 5, v_target);
  END LOOP;

  -- The fail-dangerous input: a comment on a per-student check that targets nobody.
  IF p_comment_indiv_untargeted THEN
    INSERT INTO public.submission_comments
      (submission_id, author, comment, class_id, rubric_check_id, submission_review_id, points)
    VALUES (v_submission_id, v_grader, 'untargeted per-student comment', v_class_id, v_check_indiv,
            v_review_id, 5);
  END IF;

  INSERT INTO fx VALUES
    (p_label || '_group', v_group_id::text),
    (p_label || '_submission', v_submission_id::text),
    (p_label || '_review', v_review_id::text),
    (p_label || '_ra', v_ra_id::text);
END
$mk$;

DO $build$
DECLARE
  s1 uuid := (SELECT v::uuid FROM fx WHERE k = 'stu1');
  s2 uuid := (SELECT v::uuid FROM fx WHERE k = 'stu2');
  s3 uuid := (SELECT v::uuid FROM fx WHERE k = 'stu3');
  s4 uuid := (SELECT v::uuid FROM fx WHERE k = 'stu4');
  s5 uuid := (SELECT v::uuid FROM fx WHERE k = 'stu5');
  s6 uuid := (SELECT v::uuid FROM fx WHERE k = 'stu6');
BEGIN
  -- A: empty group, one untargeted comment on the required per-student check.
  PERFORM pg_temp.mk_scenario('A', ARRAY[]::uuid[], ARRAY[]::uuid[], false, true);
  -- B: two members, a comment for each.
  PERFORM pg_temp.mk_scenario('B', ARRAY[s1, s2], ARRAY[s1, s2], false, false);
  -- C: two members, a comment for only one.
  PERFORM pg_temp.mk_scenario('C', ARRAY[s3, s4], ARRAY[s3], false, false);
  -- D: empty group, per-student part left uncovered by the review assignment (trigger path).
  PERFORM pg_temp.mk_scenario('D', ARRAY[]::uuid[], ARRAY[]::uuid[], true, true);
  -- E: two members both commented, per-student part uncovered (trigger path, normal case).
  PERFORM pg_temp.mk_scenario('E', ARRAY[s5, s6], ARRAY[s5, s6], true, false);
END
$build$;

-- Sanity: scenario A really does resolve to zero grade targets.
DO $sanity$
DECLARE
  n int;
BEGIN
  SELECT COALESCE(array_length(
    public._grade_targets_for_submission((SELECT v::bigint FROM fx WHERE k = 'A_submission')), 1), 0)
  INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'fixture broken: scenario A has % grade targets, expected 0', n;
  END IF;
  SELECT COALESCE(array_length(
    public._grade_targets_for_submission((SELECT v::bigint FROM fx WHERE k = 'B_submission')), 1), 0)
  INTO n;
  IF n <> 2 THEN
    RAISE EXCEPTION 'fixture broken: scenario B has % grade targets, expected 2', n;
  END IF;
END
$sanity$;

-- ---------------------------------------------------------------------------------------------
-- Measurement. Records, for each scenario: _submission_review_is_completable, whether completing
-- the review assignment raises (and with what message), and whether the submission_review ends up
-- completed. Each mutation is undone with a savepoint so phases are independent.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.measure(p_phase text)
RETURNS void
LANGUAGE plpgsql
AS $measure$
DECLARE
  v_label text;
  v_review_id bigint;
  v_ra_id bigint;
  v_grader uuid := (SELECT v::uuid FROM fx WHERE k = 'grader');
  v_completable boolean;
  v_msg text;
  v_raised boolean;
  v_sr_completed boolean;
BEGIN
  FOREACH v_label IN ARRAY ARRAY['A', 'B', 'C', 'D', 'E'] LOOP
    v_review_id := (SELECT v::bigint FROM fx WHERE k = v_label || '_review');
    v_ra_id := (SELECT v::bigint FROM fx WHERE k = v_label || '_ra');

    v_completable := public._submission_review_is_completable(v_review_id);
    INSERT INTO harness_results (phase, scenario, measurement, value)
    VALUES (p_phase, v_label, 'is_completable', v_completable::text);

    v_raised := NULL;
    v_msg := NULL;
    v_sr_completed := NULL;

    -- The completion is measured and then undone by raising HARNESS_UNDO: a plpgsql exception block
    -- is a subtransaction, so the raise rolls back the UPDATE and everything its triggers did, while
    -- the plpgsql variables assigned before the raise keep their values. A SAVEPOINT would also
    -- discard the rows we record in harness_results.
    BEGIN
      UPDATE public.review_assignments
      SET completed_at = now(), completed_by = v_grader
      WHERE id = v_ra_id;

      SELECT completed_at IS NOT NULL INTO v_sr_completed
      FROM public.submission_reviews WHERE id = v_review_id;

      v_raised := false;
      RAISE EXCEPTION 'HARNESS_UNDO';
    EXCEPTION WHEN others THEN
      IF SQLERRM <> 'HARNESS_UNDO' THEN
        v_raised := true;
        v_msg := SQLERRM;
        v_sr_completed := false;
      END IF;
    END;

    INSERT INTO harness_results (phase, scenario, measurement, value)
    VALUES (p_phase, v_label, 'complete_raised', v_raised::text);
    INSERT INTO harness_results (phase, scenario, measurement, value)
    VALUES (p_phase, v_label, 'submission_review_completed', v_sr_completed::text);
    IF v_msg IS NOT NULL THEN
      INSERT INTO harness_results (phase, scenario, measurement, value)
      VALUES (p_phase, v_label, 'error_message', v_msg);
    END IF;
  END LOOP;
END
$measure$;

-- Phase BEFORE: current (buggy) definitions.
SELECT pg_temp.measure('1-before');

-- Apply the fix inside this same transaction.
\echo '--- applying supabase/migrations/20260811130100_per_student_completion_fails_closed.sql ---'
\i supabase/migrations/20260811130100_per_student_completion_fails_closed.sql

-- Phase AFTER.
SELECT pg_temp.measure('2-after');

-- ---------------------------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------------------------
\echo ''
\echo '=== completability / completion by phase ==='
SELECT scenario,
       MAX(value) FILTER (WHERE phase = '1-before' AND measurement = 'is_completable') AS before_completable,
       MAX(value) FILTER (WHERE phase = '2-after' AND measurement = 'is_completable') AS after_completable,
       MAX(value) FILTER (WHERE phase = '1-before' AND measurement = 'complete_raised') AS before_raised,
       MAX(value) FILTER (WHERE phase = '2-after' AND measurement = 'complete_raised') AS after_raised,
       MAX(value) FILTER (WHERE phase = '1-before' AND measurement = 'submission_review_completed') AS before_sr_done,
       MAX(value) FILTER (WHERE phase = '2-after' AND measurement = 'submission_review_completed') AS after_sr_done
FROM harness_results
GROUP BY scenario
ORDER BY scenario;

\echo ''
\echo '=== error messages ==='
SELECT phase, scenario, value AS error_message
FROM harness_results
WHERE measurement = 'error_message'
ORDER BY phase, scenario;

-- ---------------------------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------------------------
DO $assert$
DECLARE
  v_fail text[] := ARRAY[]::text[];
  v text;
BEGIN
  -- A: was accepted before, must be refused after, and the message must explain the empty group.
  IF (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='A' AND measurement='is_completable') <> 'true' THEN
    v_fail := array_append(v_fail, 'A: expected BEFORE is_completable=true (the bug)');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='A' AND measurement='is_completable') <> 'false' THEN
    v_fail := array_append(v_fail, 'A: expected AFTER is_completable=false');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='A' AND measurement='complete_raised') <> 'false' THEN
    v_fail := array_append(v_fail, 'A: expected BEFORE completion to succeed (the bug)');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='A' AND measurement='submission_review_completed') <> 'true' THEN
    v_fail := array_append(v_fail, 'A: expected BEFORE submission_review to be completed and releasable (the bug)');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='A' AND measurement='complete_raised') <> 'true' THEN
    v_fail := array_append(v_fail, 'A: expected AFTER completion to raise');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='A' AND measurement='submission_review_completed') <> 'false' THEN
    v_fail := array_append(v_fail, 'A: expected AFTER submission_review to stay incomplete');
  END IF;

  SELECT value INTO v FROM harness_results
  WHERE phase='2-after' AND scenario='A' AND measurement='error_message';
  IF v IS NULL OR v NOT LIKE '%Per-student required check%' THEN
    v_fail := array_append(v_fail, 'A: message must name the check');
  END IF;
  IF v IS NULL OR v NOT LIKE '%no students to grade%' OR v NOT LIKE '%assignment group is empty%' THEN
    v_fail := array_append(v_fail, 'A: message must state that the submission has no students (empty group)');
  END IF;
  IF v IS NULL OR v NOT LIKE '%Per-student criteria (per-student check count)%' THEN
    v_fail := array_append(v_fail, 'A: message must name the unverifiable per-student criteria bound');
  END IF;

  -- B: normal path, both members graded -> unchanged, still completable and still completes.
  IF (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='B' AND measurement='is_completable') <> 'true'
     OR (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='B' AND measurement='is_completable') <> 'true' THEN
    v_fail := array_append(v_fail, 'B: 2 members both commented must stay completable');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='B' AND measurement='complete_raised') <> 'false'
     OR (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='B' AND measurement='submission_review_completed') <> 'true' THEN
    v_fail := array_append(v_fail, 'B: 2 members both commented must still complete');
  END IF;

  -- C: normal path, one of two graded -> still refused, and still reported as a missing check.
  IF (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='C' AND measurement='is_completable') <> 'false'
     OR (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='C' AND measurement='is_completable') <> 'false' THEN
    v_fail := array_append(v_fail, 'C: 1 of 2 commented must stay non-completable');
  END IF;
  SELECT value INTO v FROM harness_results
  WHERE phase='2-after' AND scenario='C' AND measurement='error_message';
  IF v IS NULL OR v NOT LIKE '%Missing required checks: Per-student required check%' THEN
    v_fail := array_append(v_fail, 'C: must still be reported as a missing required check');
  END IF;
  IF v LIKE '%no students to grade%' THEN
    v_fail := array_append(v_fail, 'C: must NOT claim the group is empty');
  END IF;

  -- D: trigger path (check_and_complete_submission_review + *_for_uncovered helpers). The review
  -- assignment only covers the shared part, so validate_review_assignment_completion passes and the
  -- per-student part is judged by the helpers.
  IF (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='D' AND measurement='complete_raised') <> 'false'
     OR (SELECT value FROM harness_results WHERE phase='1-before' AND scenario='D' AND measurement='submission_review_completed') <> 'true' THEN
    v_fail := array_append(v_fail, 'D: expected BEFORE the trigger to auto-complete the submission_review (the bug)');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='D' AND measurement='complete_raised') <> 'false' THEN
    v_fail := array_append(v_fail, 'D: the trigger path must not start raising (review assignment completion is legal)');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='D' AND measurement='submission_review_completed') <> 'false' THEN
    v_fail := array_append(v_fail, 'D: expected AFTER the submission_review to be left incomplete');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='D' AND measurement='is_completable') <> 'false' THEN
    v_fail := array_append(v_fail, 'D: RPC path must agree with the trigger path');
  END IF;

  -- E: same shape as D but with real members -> must still auto-complete.
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='E' AND measurement='submission_review_completed') <> 'true' THEN
    v_fail := array_append(v_fail, 'E: uncovered per-student part with all members graded must still auto-complete');
  END IF;
  IF (SELECT value FROM harness_results WHERE phase='2-after' AND scenario='E' AND measurement='is_completable') <> 'true' THEN
    v_fail := array_append(v_fail, 'E: uncovered per-student part with all members graded must stay completable');
  END IF;

  IF COALESCE(array_length(v_fail, 1), 0) > 0 THEN
    RAISE EXCEPTION E'HARNESS FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'HARNESS PASSED: all assertions held';
END
$assert$;

ROLLBACK;
