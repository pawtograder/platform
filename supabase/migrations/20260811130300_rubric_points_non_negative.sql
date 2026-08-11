-- Nothing rejected negative rubric points.
--
-- Sign semantics, from _submission_review_recompute_scores (current definition in
-- 20260811120000_restore_per_student_tweaks_in_recompute.sql, unchanged in substance since
-- 20260112090147_add_deduction_only_scoring_mode.sql):
--
--   is_deduction_only -> greatest(-coalesce(sum(comments.points), 0), -c.total_points)
--   is_additive       -> least(coalesce(sum(comments.points), 0), c.total_points)
--   otherwise         -> greatest(c.total_points - coalesce(sum(comments.points), 0), 0)
--
-- Every branch reads the summed check points as a POSITIVE magnitude and lets the mode
-- decide the sign: deduction-only negates the sum and floors it at -total_points, additive
-- adds it and caps at total_points, and the default subtracts it from total_points. So a
-- deduction is stored positive, and total_points is positive in all three modes (it is the
-- cap, or the floor's magnitude). points >= 0 and total_points >= 0 are therefore invariants
-- of all three modes, not just of additive ones -- a negative value inverts the sign the
-- mode intends (crediting points on a deduction-only criterion, subtracting them on an
-- additive one, pushing a deduct-from-total criterion above its own total). The frontend has
-- said as much for a while: lib/rubric/pointsSanitize.ts tells authors to "set the criterion
-- scoring mode to deduct-from-total or deduction-only" rather than write a negative, and
-- supabase/functions/_shared/rubricYaml.ts already rejects a negative check points value on
-- the CLI import path.
--
-- The flags that could have made a negative meaningful do not:
--   * rubric_parts.is_individual_grading / is_assign_to_student only route a criterion's
--     score into a shared, single-student, or per-student total. They do not change how the
--     criterion's own score is computed from its checks.
--   * rubrics.cap_score_to_assignment_points only caps the assembled review total.
--   * rubric_criteria.is_additive / is_deduction_only are the three branches above.
--
-- Columns constrained: rubric_checks.points, rubric_criteria.total_points.
-- Deliberately NOT constrained: submission_comments.points,
-- submission_file_comments.points, submission_artifact_comments.points (applied-comment
-- points; graders can and do override a check's value there, and constraining a scoring
-- column that carries live grades is a separate change). Option points inside
-- rubric_checks.data are jsonb and so unreachable from a column CHECK, but they ARE
-- guarded on the write path: update_rubric_full raises on them by name below, and
-- rubricYaml.ts rejects them before serializing.
--
-- NOT VALID, deliberately. Local dev DB has 0 violating rows in either column, but that is
-- 14 checks and 8 criteria -- no evidence about staging or production, which predate both
-- frontend guards (the web editor absolutized negatives to positives rather than rejecting
-- them until recently, and the CLI validator is newer still, so a legacy rubric could hold
-- one). NOT VALID enforces the invariant on every insert and update without letting a
-- deploy fail on historical data. Once staging and production report zero violations, follow
-- up with:
--   ALTER TABLE public.rubric_checks VALIDATE CONSTRAINT chk_rubric_checks_points_non_negative;
--   ALTER TABLE public.rubric_criteria VALIDATE CONSTRAINT chk_rubric_criteria_total_points_non_negative;
-- Find them with:
--   SELECT id, rubric_id, name, points FROM public.rubric_checks WHERE points < 0;
--   SELECT id, rubric_id, name, total_points FROM public.rubric_criteria WHERE total_points < 0;
--
-- NOT VALID still checks every INSERT, so the one thing a legacy negative row would newly
-- break is copying it: `assignments copy` / `rubrics import` re-insert the rows they read, so
-- duplicating an affected rubric fails until its points are fixed. That is the intended
-- trade -- the alternative is propagating a rubric whose deduction-only criterion awards
-- points -- and the two queries above find the rows to fix.

ALTER TABLE public.rubric_checks
  ADD CONSTRAINT chk_rubric_checks_points_non_negative
  CHECK (points >= 0) NOT VALID;

COMMENT ON CONSTRAINT chk_rubric_checks_points_non_negative ON public.rubric_checks IS
  'Check points are a magnitude; the criterion scoring mode (is_additive / is_deduction_only) supplies the sign. NOT VALID: enforced on write, not yet validated against legacy rows.';

ALTER TABLE public.rubric_criteria
  ADD CONSTRAINT chk_rubric_criteria_total_points_non_negative
  CHECK (total_points >= 0) NOT VALID;

COMMENT ON CONSTRAINT chk_rubric_criteria_total_points_non_negative ON public.rubric_criteria IS
  'total_points is the cap in additive mode, the amount deducted from in the default mode, and the magnitude of the floor in deduction-only mode -- non-negative in all three. NOT VALID: enforced on write, not yet validated against legacy rows.';

-- ---------------------------------------------------------------------------
-- update_rubric_full: reject negative points by name, before any write.
--
-- The write path for both the web rubric editor and `pawtograder rubrics import`. Without
-- this the new constraints surface as a bare 23514 naming only the column, and only after
-- Phase 0 has already deleted the rows the payload dropped. Verbatim copy of the definition
-- in 20260803130000_numeric_points_in_rubric_and_comment_rpcs.sql apart from the guard and
-- its three variables; signature, volatility, SECURITY DEFINER, search_path,
-- statement_timeout and the GRANT are unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_rubric_full(p_rubric jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
-- Recomputes every affected submission_review in one statement; a full-tree
-- import on a large roster needs more than the platform default.
SET statement_timeout = '3min'
AS $function$
DECLARE
  v_rubric_id bigint;
  v_class_id bigint;
  v_assignment_id bigint;
  v_review_round review_round;

  v_is_new_rubric boolean := false;
  v_broad_change boolean := false;

  v_old_name text;
  v_old_description text;
  v_old_is_private boolean;
  v_old_cap boolean;
  v_old_hide_unless_assigned boolean;
  v_old_assignment_id bigint;

  v_new_name text;
  v_new_description text;
  v_new_is_private boolean;
  v_new_cap boolean;
  v_new_hide_unless_assigned boolean;

  v_parts_added int := 0;
  v_parts_updated int := 0;
  v_parts_removed int := 0;
  v_criteria_added int := 0;
  v_criteria_updated int := 0;
  v_criteria_removed int := 0;
  v_checks_added int := 0;
  v_checks_updated int := 0;
  v_checks_removed int := 0;
  v_checks_points_cascaded int := 0;
  v_refs_added int := 0;
  v_refs_removed int := 0;
  v_reviews_recomputed int := 0;
  v_foreign_ids_remapped int := 0;

  -- Input map key -> real DB id, after insert/update phases.
  v_part_id_map jsonb := '{}'::jsonb;
  v_criteria_id_map jsonb := '{}'::jsonb;
  v_check_id_map jsonb := '{}'::jsonb;

  v_part jsonb;
  v_criterion jsonb;
  v_check jsonb;
  v_ref jsonb;

  v_input_part_id bigint;
  v_input_criteria_id bigint;
  v_input_check_id bigint;
  v_part_id bigint;
  v_criteria_id bigint;
  v_check_id bigint;
  v_review_id bigint;

  v_part_ord int;
  v_crit_ord int;
  v_check_ord int;
  v_part_map_key text;
  v_criteria_map_key text;
  v_check_map_key text;

  v_points_changed_check_ids bigint[] := ARRAY[]::bigint[];
  v_removed_check_ids bigint[] := ARRAY[]::bigint[];
  v_affected_review_ids bigint[] := ARRAY[]::bigint[];

  v_old_is_individual_grading boolean;
  v_old_is_assign_to_student boolean;
  v_old_rubric_part_id bigint;
  v_old_total_points int;
  v_old_is_additive boolean;
  v_old_is_deduction_only boolean;
  v_old_points numeric;
  v_old_criteria_id bigint;

  v_bad_name text;
  v_bad_parent_name text;
  v_bad_points numeric;

  v_changes text[] := ARRAY[]::text[];
  v_summary text;
BEGIN
  v_rubric_id := NULLIF((p_rubric->>'id')::bigint, 0);
  v_class_id := (p_rubric->>'class_id')::bigint;
  v_assignment_id := (p_rubric->>'assignment_id')::bigint;
  v_review_round := (p_rubric->>'review_round')::review_round;
  v_new_name := p_rubric->>'name';
  v_new_description := p_rubric->>'description';
  v_new_is_private := COALESCE((p_rubric->>'is_private')::boolean, false);
  v_new_cap := COALESCE((p_rubric->>'cap_score_to_assignment_points')::boolean, false);
  -- NULL when the key is absent: only overwrite hide_unless_assigned on update
  -- when the caller actually sent it.
  v_new_hide_unless_assigned := CASE
    WHEN p_rubric ? 'hide_unless_assigned'
    THEN (p_rubric->>'hide_unless_assigned')::boolean
  END;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'class_id is required';
  END IF;
  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Not authorized to edit rubrics in this class';
  END IF;
  IF v_new_name IS NULL OR length(trim(v_new_name)) = 0 THEN
    RAISE EXCEPTION 'Rubric name is required';
  END IF;

  ----------------------------------------------------------------
  -- Reject negative points before touching anything.
  --
  -- Deductions are stored POSITIVE and subtracted by
  -- _submission_review_recompute_scores, which reads sum(comments.points) as a
  -- magnitude in all three scoring modes:
  --   is_deduction_only -> greatest(-sum, -total_points)
  --   is_additive       -> least(sum, total_points)
  --   otherwise         -> greatest(total_points - sum, 0)
  -- so a negative value inverts the sign the mode intends: it credits points on a
  -- deduction-only criterion, subtracts them on an additive one, and pushes a
  -- deduct-from-total criterion above its own total.
  --
  -- Raised here rather than left to chk_rubric_checks_points_non_negative /
  -- chk_rubric_criteria_total_points_non_negative so the editor shows the offending
  -- criterion and check by name instead of a bare 23514 constraint violation. Runs
  -- before Phase 0, so a rejected payload cannot have already deleted rows.
  ----------------------------------------------------------------
  SELECT crit->>'name', part->>'name', (crit->>'total_points')::numeric
  INTO v_bad_name, v_bad_parent_name, v_bad_points
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit
  WHERE COALESCE((crit->>'total_points')::numeric, 0) < 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Criterion "%" in part "%" has negative total_points (%). Total points must be zero or greater; for deductions set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.',
      COALESCE(v_bad_name, '(unnamed)'), COALESCE(v_bad_parent_name, '(unnamed)'), v_bad_points
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT chk->>'name', crit->>'name', (chk->>'points')::numeric
  INTO v_bad_name, v_bad_parent_name, v_bad_points
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
       jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk
  WHERE COALESCE((chk->>'points')::numeric, 0) < 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Check "%" in criterion "%" has negative points (%). Points must be zero or greater; for deductions set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.',
      COALESCE(v_bad_name, '(unnamed)'), COALESCE(v_bad_parent_name, '(unnamed)'), v_bad_points
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  ----------------------------------------------------------------
  -- Option points, inside rubric_checks.data.
  --
  -- The two guards above cover the columns, and the CHECK constraints back them. Neither reaches
  -- an option's points: that value lives in jsonb, which is why the header records it as not
  -- constrainable from a column CHECK. Without this guard the only thing standing between a
  -- negative option and the database was sanitizeCheckPoints in lib/rubric/pointsSanitize.ts,
  -- which runs in the browser -- so the CLI, the YAML import path (rubric_checks.data rides the
  -- round-trip opaquely), and any direct RPC caller could still persist one. An option's points
  -- become a comment's points when a grader selects it, so a negative there inverts the scoring
  -- mode's intended sign exactly as a negative check points does.
  --
  -- Raised by name here rather than left to a constraint, matching the two guards above.
  ----------------------------------------------------------------
  SELECT opt->>'label', chk->>'name', (opt->>'points')::numeric
  INTO v_bad_name, v_bad_parent_name, v_bad_points
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
       jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk,
       jsonb_array_elements(
         CASE WHEN jsonb_typeof(chk->'data'->'options') = 'array'
              THEN chk->'data'->'options'
              ELSE '[]'::jsonb
         END
       ) opt
  WHERE COALESCE((opt->>'points')::numeric, 0) < 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Option "%" in check "%" has negative points (%). Points must be zero or greater; for deductions set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.',
      COALESCE(v_bad_name, '(unnamed)'), COALESCE(v_bad_parent_name, '(unnamed)'), v_bad_points
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_rubric_id IS NULL THEN
    INSERT INTO public.rubrics (
      name, description, assignment_id, class_id, is_private, review_round,
      cap_score_to_assignment_points, hide_unless_assigned
    )
    VALUES (
      v_new_name, v_new_description, v_assignment_id, v_class_id, v_new_is_private,
      v_review_round, v_new_cap, COALESCE(v_new_hide_unless_assigned, false)
    )
    RETURNING id INTO v_rubric_id;
    v_is_new_rubric := true;
    v_broad_change := true;
  ELSE
    SELECT name, description, is_private, cap_score_to_assignment_points, hide_unless_assigned,
           assignment_id
    INTO v_old_name, v_old_description, v_old_is_private, v_old_cap, v_old_hide_unless_assigned,
         v_old_assignment_id
    FROM public.rubrics
    WHERE id = v_rubric_id AND class_id = v_class_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rubric % not found in class %', v_rubric_id, v_class_id;
    END IF;

    -- The class is pinned above, but assignment_id was not checked against the rubric,
    -- and the part/criteria/check inserts below write v_assignment_id straight into the
    -- child rows. A payload naming a rubric on assignment A while carrying assignment
    -- B's id therefore produced children whose assignment_id disagreed with their
    -- rubric's, and the export path filters rubric_check_references by assignment_id,
    -- so those rows read back inconsistently.
    IF v_assignment_id IS DISTINCT FROM v_old_assignment_id THEN
      RAISE EXCEPTION 'assignment_id % does not match rubric %''s assignment %',
        v_assignment_id, v_rubric_id, v_old_assignment_id;
    END IF;

    IF v_old_name IS DISTINCT FROM v_new_name
       OR v_old_description IS DISTINCT FROM v_new_description
       OR v_old_is_private IS DISTINCT FROM v_new_is_private
       OR v_old_cap IS DISTINCT FROM v_new_cap
       OR (v_new_hide_unless_assigned IS NOT NULL AND v_old_hide_unless_assigned IS DISTINCT FROM v_new_hide_unless_assigned) THEN
      UPDATE public.rubrics
      SET name = v_new_name,
          description = v_new_description,
          is_private = v_new_is_private,
          cap_score_to_assignment_points = v_new_cap,
          hide_unless_assigned = COALESCE(v_new_hide_unless_assigned, hide_unless_assigned)
      WHERE id = v_rubric_id;
    END IF;

    IF v_old_cap IS DISTINCT FROM v_new_cap THEN
      v_broad_change := true;
    END IF;
  END IF;

  ----------------------------------------------------------------
  -- Phase 0: deletes (leaf → root). FKs on rubric_criteria→parts and
  -- rubric_checks→criteria are NO ACTION, so we must remove checks before
  -- criteria before parts. rubric_check_references CASCADE when checks go.
  ----------------------------------------------------------------
  WITH input_check_ids AS (
    SELECT (chk->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
         jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk
    WHERE COALESCE((chk->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_checks rc
        WHERE rc.id = (chk->>'id')::bigint AND rc.rubric_id = v_rubric_id
      )
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_removed_check_ids
  FROM public.rubric_checks
  WHERE rubric_id = v_rubric_id
    AND id NOT IN (SELECT id FROM input_check_ids);

  IF array_length(v_removed_check_ids, 1) > 0 THEN
    DELETE FROM public.rubric_checks WHERE id = ANY(v_removed_check_ids);
    v_checks_removed := array_length(v_removed_check_ids, 1);
    v_broad_change := true;
  END IF;

  WITH input_criteria_ids AS (
    SELECT (crit->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit
    WHERE COALESCE((crit->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_criteria rc
        WHERE rc.id = (crit->>'id')::bigint AND rc.rubric_id = v_rubric_id
      )
  ),
  del AS (
    DELETE FROM public.rubric_criteria
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_criteria_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_criteria_removed FROM del;

  IF v_criteria_removed > 0 THEN
    v_broad_change := true;
  END IF;

  WITH input_part_ids AS (
    SELECT (elem->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) elem
    WHERE COALESCE((elem->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_parts rp
        WHERE rp.id = (elem->>'id')::bigint AND rp.rubric_id = v_rubric_id
      )
  ),
  del AS (
    DELETE FROM public.rubric_parts
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_part_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_parts_removed FROM del;

  IF v_parts_removed > 0 THEN
    v_broad_change := true;
  END IF;

  ----------------------------------------------------------------
  -- Phase 1: upsert parts.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);

    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;

      -- _submission_review_recompute_scores joins rubric_criteria to rubric_parts and
      -- branches on these two flags to decide whether a criterion's points land in the
      -- shared total, one student's individual total, or a per-student assigned total.
      -- Flipping either therefore reclassifies every criterion under the part, so the
      -- existing reviews have to be recomputed -- and this branch never said so, leaving
      -- individual_scores and per_student_grading_totals computed under the old mode
      -- while the gradebook displayed them as current.
      SELECT is_individual_grading, is_assign_to_student
      INTO v_old_is_individual_grading, v_old_is_assign_to_student
      FROM public.rubric_parts WHERE id = v_input_part_id;

      IF v_old_is_individual_grading IS DISTINCT FROM COALESCE((v_part->>'is_individual_grading')::boolean, false)
         OR v_old_is_assign_to_student IS DISTINCT FROM COALESCE((v_part->>'is_assign_to_student')::boolean, false) THEN
        v_broad_change := true;
      END IF;

      UPDATE public.rubric_parts
      SET name = v_part->>'name',
          description = v_part->>'description',
          ordinal = COALESCE((v_part->>'ordinal')::int, 0),
          data = v_part->'data',
          is_individual_grading = COALESCE((v_part->>'is_individual_grading')::boolean, false),
          is_assign_to_student = COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      WHERE id = v_input_part_id AND rubric_id = v_rubric_id;

      v_part_id := v_input_part_id;
      v_parts_updated := v_parts_updated + 1;
    ELSE
      IF v_input_part_id > 0 THEN
        v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
      END IF;
      v_part_map_key := 'new_part_' || v_part_ord::text;

      INSERT INTO public.rubric_parts (
        name, description, ordinal, rubric_id, class_id, assignment_id,
        data, is_individual_grading, is_assign_to_student
      ) VALUES (
        v_part->>'name',
        v_part->>'description',
        COALESCE((v_part->>'ordinal')::int, 0),
        v_rubric_id, v_class_id, v_assignment_id,
        v_part->'data',
        COALESCE((v_part->>'is_individual_grading')::boolean, false),
        COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      ) RETURNING id INTO v_part_id;

      v_parts_added := v_parts_added + 1;
      v_broad_change := true;
    END IF;

    v_part_id_map := v_part_id_map || jsonb_build_object(v_part_map_key, v_part_id);
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 2: upsert criteria.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;
    v_part_id := (v_part_id_map->>v_part_map_key)::bigint;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);

      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;

        -- rubric_part_id is in the snapshot because the UPDATE below rewrites it: YAML
        -- can keep a criterion's id while moving it under a different part. If the new
        -- parent has a different grading mode, recompute_scores classifies the
        -- criterion's points differently through its rubric_parts join, so the move is
        -- as broad a change as editing the part's own flags.
        SELECT total_points, is_additive, is_deduction_only, rubric_part_id
        INTO v_old_total_points, v_old_is_additive, v_old_is_deduction_only, v_old_rubric_part_id
        FROM public.rubric_criteria WHERE id = v_input_criteria_id;

        IF v_old_total_points IS DISTINCT FROM COALESCE((v_criterion->>'total_points')::int, 0)
           OR v_old_is_additive IS DISTINCT FROM COALESCE((v_criterion->>'is_additive')::boolean, false)
           OR v_old_is_deduction_only IS DISTINCT FROM COALESCE((v_criterion->>'is_deduction_only')::boolean, false)
           OR v_old_rubric_part_id IS DISTINCT FROM v_part_id THEN
          v_broad_change := true;
        END IF;

        UPDATE public.rubric_criteria
        SET name = v_criterion->>'name',
            description = v_criterion->>'description',
            ordinal = COALESCE((v_criterion->>'ordinal')::int, 0),
            rubric_part_id = v_part_id,
            data = v_criterion->'data',
            is_additive = COALESCE((v_criterion->>'is_additive')::boolean, false),
            is_deduction_only = COALESCE((v_criterion->>'is_deduction_only')::boolean, false),
            total_points = COALESCE((v_criterion->>'total_points')::int, 0),
            max_checks_per_submission = NULLIF(v_criterion->>'max_checks_per_submission', '')::int,
            min_checks_per_submission = NULLIF(v_criterion->>'min_checks_per_submission', '')::int
        WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id;

        v_criteria_id := v_input_criteria_id;
        v_criteria_updated := v_criteria_updated + 1;
      ELSE
        IF v_input_criteria_id > 0 THEN
          v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
        END IF;
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;

        INSERT INTO public.rubric_criteria (
          name, description, ordinal, rubric_id, rubric_part_id, class_id, assignment_id,
          data, is_additive, is_deduction_only, total_points,
          max_checks_per_submission, min_checks_per_submission
        ) VALUES (
          v_criterion->>'name',
          v_criterion->>'description',
          COALESCE((v_criterion->>'ordinal')::int, 0),
          v_rubric_id, v_part_id, v_class_id, v_assignment_id,
          v_criterion->'data',
          COALESCE((v_criterion->>'is_additive')::boolean, false),
          COALESCE((v_criterion->>'is_deduction_only')::boolean, false),
          COALESCE((v_criterion->>'total_points')::int, 0),
          NULLIF(v_criterion->>'max_checks_per_submission', '')::int,
          NULLIF(v_criterion->>'min_checks_per_submission', '')::int
        ) RETURNING id INTO v_criteria_id;

        v_criteria_added := v_criteria_added + 1;
        v_broad_change := true;
      END IF;

      v_criteria_id_map := v_criteria_id_map || jsonb_build_object(v_criteria_map_key, v_criteria_id);
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 3: upsert checks.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;
      ELSE
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;
      END IF;
      v_criteria_id := (v_criteria_id_map->>v_criteria_map_key)::bigint;

      FOR v_check, v_check_ord IN
        SELECT elem, ord::int
        FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);

        IF v_input_check_id > 0
           AND EXISTS (
             SELECT 1 FROM public.rubric_checks
             WHERE id = v_input_check_id AND rubric_id = v_rubric_id
           ) THEN
          v_check_map_key := v_input_check_id::text;

          SELECT points, rubric_criteria_id INTO v_old_points, v_old_criteria_id
          FROM public.rubric_checks WHERE id = v_input_check_id;

          IF v_old_points IS DISTINCT FROM COALESCE((v_check->>'points')::numeric, 0) THEN
            v_points_changed_check_ids := array_append(v_points_changed_check_ids, v_input_check_id);
          END IF;

          -- Reparenting a check is a scoring change even when its points do not move.
          -- _submission_review_recompute_scores joins rubric_checks to rubric_criteria on
          -- rubric_criteria_id and groups by the criterion, applying *that* criterion's
          -- is_additive / is_deduction_only / total_points. So a check moved under a
          -- different criterion is scored by different rules, and recording only point
          -- changes left every affected submission_reviews.total_score computed against
          -- the old parent until some unrelated edit happened to trigger a recompute.
          IF v_old_criteria_id IS DISTINCT FROM v_criteria_id THEN
            v_broad_change := true;
          END IF;

          UPDATE public.rubric_checks
          SET name = v_check->>'name',
              description = v_check->>'description',
              ordinal = COALESCE((v_check->>'ordinal')::int, 0),
              rubric_criteria_id = v_criteria_id,
              data = v_check->'data',
              file = v_check->>'file',
              artifact = v_check->>'artifact',
              "group" = v_check->>'group',
              is_annotation = COALESCE((v_check->>'is_annotation')::boolean, false),
              is_comment_required = COALESCE((v_check->>'is_comment_required')::boolean, false),
              is_required = COALESCE((v_check->>'is_required')::boolean, false),
              max_annotations = NULLIF(v_check->>'max_annotations', '')::int,
              points = COALESCE((v_check->>'points')::numeric, 0),
              annotation_target = v_check->>'annotation_target',
              student_visibility = COALESCE(
                (v_check->>'student_visibility')::rubric_check_student_visibility,
                'always'::rubric_check_student_visibility
              ),
              kpi_category = NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          WHERE id = v_input_check_id AND rubric_id = v_rubric_id;

          v_check_id := v_input_check_id;
          v_checks_updated := v_checks_updated + 1;
        ELSE
          IF v_input_check_id > 0 THEN
            v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
          END IF;
          v_check_map_key := 'new_check_' || v_part_ord::text || '_' || v_crit_ord::text || '_' || v_check_ord::text;

          INSERT INTO public.rubric_checks (
            name, description, ordinal, rubric_criteria_id, rubric_id, class_id, assignment_id,
            data, file, artifact, "group",
            is_annotation, is_comment_required, is_required,
            max_annotations, points, annotation_target, student_visibility, kpi_category
          ) VALUES (
            v_check->>'name',
            v_check->>'description',
            COALESCE((v_check->>'ordinal')::int, 0),
            v_criteria_id, v_rubric_id, v_class_id, v_assignment_id,
            v_check->'data',
            v_check->>'file',
            v_check->>'artifact',
            v_check->>'group',
            COALESCE((v_check->>'is_annotation')::boolean, false),
            COALESCE((v_check->>'is_comment_required')::boolean, false),
            COALESCE((v_check->>'is_required')::boolean, false),
            NULLIF(v_check->>'max_annotations', '')::int,
            COALESCE((v_check->>'points')::numeric, 0),
            v_check->>'annotation_target',
            COALESCE((v_check->>'student_visibility')::rubric_check_student_visibility, 'always'::rubric_check_student_visibility),
            NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          ) RETURNING id INTO v_check_id;

          v_checks_added := v_checks_added + 1;
          v_broad_change := true;
        END IF;

        v_check_id_map := v_check_id_map || jsonb_build_object(v_check_map_key, v_check_id);
      END LOOP;
    END LOOP;
  END LOOP;

  IF array_length(v_points_changed_check_ids, 1) > 0 THEN
    UPDATE public.submission_comments sc
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sc.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    UPDATE public.submission_file_comments sfc
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sfc.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    UPDATE public.submission_artifact_comments sac
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sac.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    v_checks_points_cascaded := array_length(v_points_changed_check_ids, 1);
  END IF;

  ----------------------------------------------------------------
  -- Phase 4: rubric_check_references.
  ----------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _desired_refs (
    referencing_check_id bigint NOT NULL,
    referenced_check_id bigint NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE _desired_refs;

  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;
      ELSE
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;
      END IF;

      FOR v_check, v_check_ord IN
        SELECT elem, ord::int
        FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);
        IF v_input_check_id > 0
           AND EXISTS (
             SELECT 1 FROM public.rubric_checks
             WHERE id = v_input_check_id AND rubric_id = v_rubric_id
           ) THEN
          v_check_map_key := v_input_check_id::text;
        ELSE
          v_check_map_key := 'new_check_' || v_part_ord::text || '_' || v_crit_ord::text || '_' || v_check_ord::text;
        END IF;
        v_check_id := (v_check_id_map->>v_check_map_key)::bigint;

        FOR v_ref IN SELECT * FROM jsonb_array_elements(COALESCE(v_check->'references', '[]'::jsonb))
        LOOP
          INSERT INTO _desired_refs (referencing_check_id, referenced_check_id)
          VALUES (v_check_id, (v_ref->>'referenced_rubric_check_id')::bigint);
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  WITH del AS (
    DELETE FROM public.rubric_check_references rcr
    WHERE rcr.rubric_id = v_rubric_id
      AND NOT EXISTS (
        SELECT 1 FROM _desired_refs d
        WHERE d.referencing_check_id = rcr.referencing_rubric_check_id
          AND d.referenced_check_id = rcr.referenced_rubric_check_id
      )
    RETURNING id
  )
  SELECT count(*) INTO v_refs_removed FROM del;

  WITH ins AS (
    INSERT INTO public.rubric_check_references (
      referencing_rubric_check_id, referenced_rubric_check_id,
      rubric_id, class_id, assignment_id
    )
    SELECT d.referencing_check_id, d.referenced_check_id,
           v_rubric_id, v_class_id, v_assignment_id
    FROM _desired_refs d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rubric_check_references rcr
      WHERE rcr.referencing_rubric_check_id = d.referencing_check_id
        AND rcr.referenced_rubric_check_id = d.referenced_check_id
        AND rcr.rubric_id = v_rubric_id
    )
    RETURNING id
  )
  SELECT count(*) INTO v_refs_added FROM ins;

  IF v_is_new_rubric THEN
    v_affected_review_ids := ARRAY[]::bigint[];
  ELSIF v_broad_change THEN
    SELECT COALESCE(array_agg(DISTINCT sr.id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM public.submission_reviews sr
    WHERE sr.rubric_id = v_rubric_id;
  ELSE
    WITH touched_check_ids AS (
      SELECT unnest(v_points_changed_check_ids || v_removed_check_ids) AS id
    ),
    touched AS (
      SELECT submission_review_id FROM public.submission_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
      UNION
      SELECT submission_review_id FROM public.submission_file_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
      UNION
      SELECT submission_review_id FROM public.submission_artifact_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
    )
    SELECT COALESCE(array_agg(DISTINCT submission_review_id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM touched;
  END IF;

  FOREACH v_review_id IN ARRAY v_affected_review_ids LOOP
    PERFORM public._submission_review_recompute_scores(v_review_id);
    v_reviews_recomputed := v_reviews_recomputed + 1;
  END LOOP;

  v_summary := CASE WHEN v_is_new_rubric THEN 'Created rubric.' ELSE 'Saved rubric.' END;

  IF v_parts_added > 0 THEN v_changes := v_changes || (v_parts_added || ' part' || CASE WHEN v_parts_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_parts_updated > 0 THEN v_changes := v_changes || (v_parts_updated || ' part' || CASE WHEN v_parts_updated = 1 THEN '' ELSE 's' END || ' updated'); END IF;
  IF v_parts_removed > 0 THEN v_changes := v_changes || (v_parts_removed || ' part' || CASE WHEN v_parts_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;
  IF v_criteria_added > 0 THEN v_changes := v_changes || (v_criteria_added || ' criteri' || CASE WHEN v_criteria_added = 1 THEN 'on' ELSE 'a' END || ' added'); END IF;
  IF v_criteria_updated > 0 THEN v_changes := v_changes || (v_criteria_updated || ' criteri' || CASE WHEN v_criteria_updated = 1 THEN 'on' ELSE 'a' END || ' updated'); END IF;
  IF v_criteria_removed > 0 THEN v_changes := v_changes || (v_criteria_removed || ' criteri' || CASE WHEN v_criteria_removed = 1 THEN 'on' ELSE 'a' END || ' removed'); END IF;
  IF v_checks_added > 0 THEN v_changes := v_changes || (v_checks_added || ' check' || CASE WHEN v_checks_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_checks_updated > 0 THEN v_changes := v_changes || (v_checks_updated || ' check' || CASE WHEN v_checks_updated = 1 THEN '' ELSE 's' END || ' updated'); END IF;
  IF v_checks_removed > 0 THEN v_changes := v_changes || (v_checks_removed || ' check' || CASE WHEN v_checks_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;
  IF v_refs_added > 0 THEN v_changes := v_changes || (v_refs_added || ' reference' || CASE WHEN v_refs_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_refs_removed > 0 THEN v_changes := v_changes || (v_refs_removed || ' reference' || CASE WHEN v_refs_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;

  IF array_length(v_changes, 1) > 0 THEN
    v_summary := v_summary || ' ' || array_to_string(v_changes, ', ') || '.';
  ELSIF NOT v_is_new_rubric THEN
    v_summary := v_summary || ' No structural changes.';
  END IF;

  IF v_foreign_ids_remapped > 0 THEN
    v_summary := v_summary || ' ' || v_foreign_ids_remapped || ' item(s) with unrecognized ids treated as new.';
  END IF;

  IF v_checks_points_cascaded > 0 THEN
    v_summary := v_summary || ' Cascaded new points to existing comments on '
              || v_checks_points_cascaded || ' check'
              || CASE WHEN v_checks_points_cascaded = 1 THEN '' ELSE 's' END || '.';
  END IF;

  IF v_reviews_recomputed > 0 THEN
    v_summary := v_summary || ' Recomputed scores on '
              || v_reviews_recomputed || ' submission review'
              || CASE WHEN v_reviews_recomputed = 1 THEN '' ELSE 's' END || '.';
  END IF;

  RETURN v_summary;
END;
$function$;

COMMENT ON FUNCTION public.update_rubric_full(jsonb) IS
  'Atomically apply a hydrated rubric (top-level fields + parts/criteria/checks/references) in one transaction, cascade points changes to existing comments, recompute affected submission_reviews, and return a friendly summary. Positive ids not owned by the target rubric are inserted as new rows (copy/paste YAML). Removes checks before criteria before parts to satisfy FK constraints. Persists hide_unless_assigned (default false on insert; only overwritten on update when the key is present). Check points are numeric, and both check points and criterion total_points must be non-negative (rejected by name before any write; deductions are stored positive and subtracted by the scoring mode). Kept in step with the TypeScript diff planner in supabase/functions/_shared/rubricYaml.ts.';

GRANT EXECUTE ON FUNCTION public.update_rubric_full(jsonb) TO authenticated;
