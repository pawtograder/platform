-- Store rubric and comment points as numeric, give update_rubric_full a statement
-- timeout, and pin assignment_id to the rubric being written.
--
-- Five defects in update_rubric_full, all pre-existing and all reachable from the
-- web rubric editor as well as from `pawtograder rubrics import`; then the matching
-- numeric fix in cli_import_submission_comments_batch at the bottom of this file.
--
-- 1. rubric_checks.points has been `numeric` since
--    20250505234500_remote_schema.sql, but this function declared `v_old_points int`
--    and cast `(v_check->>'points')::int` in three places. The text->integer cast
--    raises 22P02 on a fractional value, so a rubric with fractional check points
--    could not be saved at all; and where the cast did not raise, assigning the
--    existing numeric column into an int variable *rounds*, so saving such a rubric
--    silently changed its points. Now numeric throughout.
--
-- 2. The function had no statement_timeout. Any added or removed part/criterion/
--    check sets v_broad_change, whose tail loop calls
--    _submission_review_recompute_scores once per affected review — several hundred
--    recomputes in a single statement for a full-tree import on a large roster.
--    3min matches what 20251124233922_extend-more-rpc-timeouts.sql set on the other
--    heavy RPCs.
--
-- 3. On the update path the function pinned class_id but never checked
--    assignment_id against the rubric it was about to modify, while writing that
--    assignment_id into every child row it inserted. A payload naming a rubric on one
--    assignment and carrying another's id produced rubric_parts/criteria/checks whose
--    assignment_id disagreed with their own rubric, which the export path (filtering
--    rubric_check_references by assignment_id) then read back inconsistently. Only an
--    instructor in the class could reach it, and both existing callers derive the two
--    ids from the same resolved rubric, so nothing legitimate is rejected.
--
-- 4. Updating an existing part rewrote is_individual_grading/is_assign_to_student
--    without setting v_broad_change. _submission_review_recompute_scores branches on
--    those flags (via rubric_criteria -> rubric_parts) to split a criterion's points
--    between the shared total, a single student's total, and per-student assigned
--    totals -- so flipping either reclassified every criterion under the part while
--    the tail recompute loop skipped the affected reviews. individual_scores and
--    per_student_grading_totals stayed on the old mode and the gradebook showed them
--    as current.
--
-- 5. Updating an existing criterion rewrote rubric_part_id -- YAML may keep a
--    criterion's id while moving it under another part -- but the preceding snapshot
--    read only its scoring fields, so a move onto a part with a different grading mode
--    went undetected and left the same stale totals as (4).
--
-- The body is otherwise byte-identical to 20260522180000.

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
  'Atomically apply a hydrated rubric (top-level fields + parts/criteria/checks/references) in one transaction, cascade points changes to existing comments, recompute affected submission_reviews, and return a friendly summary. Positive ids not owned by the target rubric are inserted as new rows (copy/paste YAML). Removes checks before criteria before parts to satisfy FK constraints. Persists hide_unless_assigned (default false on insert; only overwritten on update when the key is present). Check points are numeric. Kept in step with the TypeScript diff planner in supabase/functions/_shared/rubricYaml.ts.';

GRANT EXECUTE ON FUNCTION public.update_rubric_full(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- cli_import_submission_comments_batch: the same numeric-points defect.
--
-- `pawtograder submissions comments import` funnels every comment's points
-- through `points int` / `eff_points int` temp columns and a
-- `(value->>'points')::integer` cast, while submission_file_comments.points,
-- submission_artifact_comments.points, submission_comments.points, and
-- rubric_checks.points have all been `numeric` since
-- 20250505234500_remote_schema.sql. So:
--
--   * `eff_points = coalesce(fc.points, (SELECT rc.points FROM rubric_checks ...))`
--     pulls a fractional check's points into an int column, rounding a 0.5-point
--     deduction to 0 or 1 on real student grades; and
--   * a fractional `points` in the import manifest fails outright with 22P02.
--
-- Fractional check points were previously unreachable because update_rubric_full
-- could not save them (above), so this was latent. Fixing that makes it live.
--
-- Body is otherwise byte-identical to 20260319120000: only the three temp tables'
-- `points`/`eff_points` columns, the three `::integer` points casts, and the three
-- `NULL::int` eff_points placeholders change. (value->>'line')::integer stays
-- integer -- line numbers are not fractional.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cli_import_submission_comments_batch(
  p_class_id bigint,
  p_assignment_id bigint,
  p_mode text,
  p_dry_run boolean,
  p_file_comments jsonb,
  p_artifact_comments jsonb,
  p_submission_comments jsonb,
  p_sync_submission_ids bigint[],
  p_default_author uuid,
  p_authors_by_submission jsonb,
  p_skip_sync boolean DEFAULT false,
  p_run_sync_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rubric_id bigint;
  v_file_ins int := 0;
  v_file_skip int := 0;
  v_file_err int := 0;
  v_art_ins int := 0;
  v_art_skip int := 0;
  v_art_err int := 0;
  v_sub_ins int := 0;
  v_sub_skip int := 0;
  v_sub_err int := 0;
  v_del_file int := 0;
  v_del_art int := 0;
  v_del_sub int := 0;
  v_all_rubric_ids bigint[];
  v_sync_ids bigint[];
  v_errs jsonb := '[]'::jsonb;
  r jsonb;
BEGIN
  IF p_mode NOT IN ('import', 'sync') THEN
    RAISE EXCEPTION 'cli_import_submission_comments_batch: invalid mode %', p_mode;
  END IF;

  IF p_run_sync_only AND p_skip_sync THEN
    RAISE EXCEPTION 'cli_import_submission_comments_batch: invalid p_run_sync_only with p_skip_sync';
  END IF;

  p_file_comments := coalesce(p_file_comments, '[]'::jsonb);
  p_artifact_comments := coalesce(p_artifact_comments, '[]'::jsonb);
  p_submission_comments := coalesce(p_submission_comments, '[]'::jsonb);
  p_authors_by_submission := coalesce(p_authors_by_submission, '{}'::jsonb);

  IF p_run_sync_only THEN
    v_rubric_id := NULL;
  ELSE
    SELECT a.grading_rubric_id INTO v_rubric_id
    FROM assignments a
    WHERE a.id = p_assignment_id
      AND a.class_id = p_class_id;
  END IF;

  SELECT coalesce(
    array_agg(DISTINCT x.rubric_check_id),
    ARRAY[]::bigint[]
  ) INTO v_all_rubric_ids
  FROM (
    SELECT NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
    FROM jsonb_array_elements(p_file_comments) AS e(value)
    UNION ALL
    SELECT NULLIF(value->>'rubric_check_id', '')::bigint
    FROM jsonb_array_elements(p_artifact_comments) AS e(value)
    UNION ALL
    SELECT NULLIF(value->>'rubric_check_id', '')::bigint
    FROM jsonb_array_elements(p_submission_comments) AS e(value)
  ) x
  WHERE x.rubric_check_id IS NOT NULL;

  IF p_sync_submission_ids IS NOT NULL AND coalesce(array_length(p_sync_submission_ids, 1), 0) > 0 THEN
    v_sync_ids := p_sync_submission_ids;
  ELSIF p_mode = 'sync' THEN
    SELECT coalesce(
      array_agg(DISTINCT s.submission_id),
      ARRAY[]::bigint[]
    ) INTO v_sync_ids
    FROM (
      SELECT (value->>'submission_id')::bigint AS submission_id
      FROM jsonb_array_elements(p_file_comments) AS e(value)
      UNION
      SELECT (value->>'submission_id')::bigint
      FROM jsonb_array_elements(p_artifact_comments) AS e(value)
      UNION
      SELECT (value->>'submission_id')::bigint
      FROM jsonb_array_elements(p_submission_comments) AS e(value)
    ) s;
  ELSE
    v_sync_ids := ARRAY[]::bigint[];
  END IF;

  -- ---------- FILE COMMENTS ---------- (skipped when p_run_sync_only)
  IF NOT p_run_sync_only THEN

  CREATE TEMP TABLE _cli_fc (
    submission_id bigint,
    file_name text,
    line int,
    comment text,
    rubric_check_id bigint,
    points numeric,
    author uuid,
    submission_file_id bigint,
    grading_review_id bigint,
    class_id bigint,
    eff_points numeric,
    err text,
    should_insert boolean
  ) ON COMMIT DROP;

  INSERT INTO _cli_fc (
    submission_id, file_name, line, comment, rubric_check_id, points, author,
    submission_file_id, grading_review_id, class_id, eff_points, err, should_insert
  )
  SELECT
    (value->>'submission_id')::bigint,
    value->>'file_name',
    (value->>'line')::integer,
    value->>'comment',
    NULLIF(value->>'rubric_check_id', '')::bigint,
    NULLIF(value->>'points', '')::numeric,
    COALESCE(
      NULLIF(value->>'author', '')::uuid,
      NULLIF(p_authors_by_submission->>(value->>'submission_id'), '')::uuid,
      p_default_author
    ),
    NULL::bigint,
    s.grading_review_id,
    s.class_id,
    NULL::numeric,
    NULL::text,
    false
  FROM jsonb_array_elements(p_file_comments) AS e(value)
  INNER JOIN submissions s ON s.id = (value->>'submission_id')::bigint;

  UPDATE _cli_fc fc
  SET
    err = CASE
      WHEN fc.class_id IS DISTINCT FROM p_class_id OR NOT EXISTS (
        SELECT 1 FROM submissions ss
        WHERE ss.id = fc.submission_id AND ss.assignment_id = p_assignment_id AND ss.class_id = p_class_id
      ) THEN 'submission_not_in_class_assignment'
      WHEN fc.author IS NULL THEN 'missing_author'
      WHEN fc.rubric_check_id IS NOT NULL AND (
        v_rubric_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM rubric_checks rc WHERE rc.id = fc.rubric_check_id AND rc.rubric_id = v_rubric_id)
      ) THEN 'invalid_rubric_check_id'
      ELSE NULL
    END,
    submission_file_id = public._cli_resolve_submission_file_id(fc.submission_id, fc.file_name),
    eff_points = coalesce(
      fc.points,
      (SELECT rc.points FROM rubric_checks rc WHERE rc.id = fc.rubric_check_id LIMIT 1)
    )
  WHERE true;

  UPDATE _cli_fc fc
  SET should_insert = (
    fc.err IS NULL
    AND fc.submission_file_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM submission_file_comments sfc
      WHERE sfc.submission_file_id = fc.submission_file_id
        AND sfc.submission_id = fc.submission_id
        AND sfc.deleted_at IS NULL
        AND sfc.line IS NOT DISTINCT FROM fc.line
        AND sfc.comment IS NOT DISTINCT FROM fc.comment
        AND sfc.rubric_check_id IS NOT DISTINCT FROM fc.rubric_check_id
    )
  )
  WHERE true;

  -- Within-batch dedupe: same file + line + body + rubric_check (import idempotency)
  UPDATE _cli_fc fc
  SET should_insert = false
  WHERE fc.should_insert
    AND EXISTS (
      SELECT 1 FROM _cli_fc fc2
      WHERE fc2.should_insert
        AND fc2.submission_file_id = fc.submission_file_id
        AND fc2.line IS NOT DISTINCT FROM fc.line
        AND fc2.comment IS NOT DISTINCT FROM fc.comment
        AND fc2.rubric_check_id IS NOT DISTINCT FROM fc.rubric_check_id
        AND fc2.ctid < fc.ctid
    );

  SELECT count(*) FILTER (WHERE should_insert) INTO v_file_ins FROM _cli_fc;
  SELECT count(*) FILTER (
    WHERE err IS NULL AND submission_file_id IS NOT NULL AND NOT should_insert
  ) INTO v_file_skip FROM _cli_fc;
  SELECT count(*) FILTER (
    WHERE err IS NOT NULL OR (err IS NULL AND submission_file_id IS NULL)
  ) INTO v_file_err FROM _cli_fc;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', 'file_comment',
        'submission_id', fc.submission_id,
        'file_name', fc.file_name,
        'reason', coalesce(fc.err, CASE WHEN fc.submission_file_id IS NULL THEN 'file_not_found' END)
      )
    ),
    '[]'::jsonb
  ) INTO r
  FROM _cli_fc fc
  WHERE fc.err IS NOT NULL OR (fc.err IS NULL AND fc.submission_file_id IS NULL);
  v_errs := v_errs || coalesce(r, '[]'::jsonb);

  IF NOT p_dry_run THEN
    INSERT INTO submission_file_comments (
      submission_file_id,
      submission_id,
      comment,
      line,
      points,
      rubric_check_id,
      released,
      eventually_visible,
      submission_review_id,
      class_id,
      author
    )
    SELECT
      fc.submission_file_id,
      fc.submission_id,
      fc.comment,
      fc.line,
      fc.eff_points,
      fc.rubric_check_id,
      false,
      true,
      fc.grading_review_id,
      fc.class_id,
      fc.author
    FROM _cli_fc fc
    WHERE fc.should_insert;
  END IF;

  DROP TABLE _cli_fc;

  -- ---------- ARTIFACT COMMENTS ----------
  CREATE TEMP TABLE _cli_ac (
    submission_id bigint,
    artifact_name text,
    comment text,
    rubric_check_id bigint,
    points numeric,
    author uuid,
    submission_artifact_id bigint,
    grading_review_id bigint,
    class_id bigint,
    eff_points numeric,
    err text,
    should_insert boolean
  ) ON COMMIT DROP;

  INSERT INTO _cli_ac (
    submission_id, artifact_name, comment, rubric_check_id, points, author,
    submission_artifact_id, grading_review_id, class_id, eff_points, err, should_insert
  )
  SELECT
    (value->>'submission_id')::bigint,
    value->>'artifact_name',
    value->>'comment',
    NULLIF(value->>'rubric_check_id', '')::bigint,
    NULLIF(value->>'points', '')::numeric,
    COALESCE(
      NULLIF(value->>'author', '')::uuid,
      NULLIF(p_authors_by_submission->>(value->>'submission_id'), '')::uuid,
      p_default_author
    ),
    NULL::bigint,
    s.grading_review_id,
    s.class_id,
    NULL::numeric,
    NULL::text,
    false
  FROM jsonb_array_elements(p_artifact_comments) AS e(value)
  INNER JOIN submissions s ON s.id = (value->>'submission_id')::bigint;

  UPDATE _cli_ac ac
  SET
    err = CASE
      WHEN ac.class_id IS DISTINCT FROM p_class_id OR NOT EXISTS (
        SELECT 1 FROM submissions ss
        WHERE ss.id = ac.submission_id AND ss.assignment_id = p_assignment_id AND ss.class_id = p_class_id
      ) THEN 'submission_not_in_class_assignment'
      WHEN ac.author IS NULL THEN 'missing_author'
      WHEN ac.artifact_name IS NULL OR ac.artifact_name = '' THEN 'missing_artifact_name'
      WHEN ac.rubric_check_id IS NOT NULL AND (
        v_rubric_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM rubric_checks rc WHERE rc.id = ac.rubric_check_id AND rc.rubric_id = v_rubric_id)
      ) THEN 'invalid_rubric_check_id'
      ELSE NULL
    END,
    submission_artifact_id = (
      SELECT sa.id FROM submission_artifacts sa
      WHERE sa.submission_id = ac.submission_id AND sa.name = ac.artifact_name
      LIMIT 1
    ),
    eff_points = coalesce(
      ac.points,
      (SELECT rc.points FROM rubric_checks rc WHERE rc.id = ac.rubric_check_id LIMIT 1)
    )
  WHERE true;

  UPDATE _cli_ac ac
  SET should_insert = (
    ac.err IS NULL
    AND ac.submission_artifact_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM submission_artifact_comments sac
      WHERE sac.submission_artifact_id = ac.submission_artifact_id
        AND sac.submission_id = ac.submission_id
        AND sac.deleted_at IS NULL
        AND sac.comment IS NOT DISTINCT FROM ac.comment
        AND sac.rubric_check_id IS NOT DISTINCT FROM ac.rubric_check_id
    )
  )
  WHERE true;

  UPDATE _cli_ac ac
  SET should_insert = false
  WHERE ac.should_insert
    AND EXISTS (
      SELECT 1 FROM _cli_ac ac2
      WHERE ac2.should_insert
        AND ac2.submission_artifact_id = ac.submission_artifact_id
        AND ac2.comment IS NOT DISTINCT FROM ac.comment
        AND ac2.rubric_check_id IS NOT DISTINCT FROM ac.rubric_check_id
        AND ac2.ctid < ac.ctid
    );

  SELECT count(*) FILTER (WHERE should_insert) INTO v_art_ins FROM _cli_ac;
  SELECT count(*) FILTER (
    WHERE err IS NULL AND submission_artifact_id IS NOT NULL AND NOT should_insert
  ) INTO v_art_skip FROM _cli_ac;
  SELECT count(*) FILTER (
    WHERE err IS NOT NULL OR (err IS NULL AND submission_artifact_id IS NULL)
  ) INTO v_art_err FROM _cli_ac;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', 'artifact_comment',
        'submission_id', ac.submission_id,
        'artifact_name', ac.artifact_name,
        'reason', coalesce(ac.err, CASE WHEN ac.submission_artifact_id IS NULL THEN 'artifact_not_found' END)
      )
    ),
    '[]'::jsonb
  ) INTO r
  FROM _cli_ac ac
  WHERE ac.err IS NOT NULL OR (ac.err IS NULL AND ac.submission_artifact_id IS NULL);
  v_errs := v_errs || coalesce(r, '[]'::jsonb);

  IF NOT p_dry_run THEN
    INSERT INTO submission_artifact_comments (
      submission_artifact_id,
      submission_id,
      comment,
      class_id,
      points,
      rubric_check_id,
      author,
      released,
      eventually_visible,
      submission_review_id
    )
    SELECT
      ac.submission_artifact_id,
      ac.submission_id,
      ac.comment,
      ac.class_id,
      ac.eff_points,
      ac.rubric_check_id,
      ac.author,
      false,
      true,
      ac.grading_review_id
    FROM _cli_ac ac
    WHERE ac.should_insert;
  END IF;

  DROP TABLE _cli_ac;

  -- ---------- SUBMISSION COMMENTS ----------
  CREATE TEMP TABLE _cli_sc (
    submission_id bigint,
    comment text,
    rubric_check_id bigint,
    points numeric,
    author uuid,
    grading_review_id bigint,
    class_id bigint,
    eff_points numeric,
    err text,
    should_insert boolean
  ) ON COMMIT DROP;

  INSERT INTO _cli_sc (
    submission_id, comment, rubric_check_id, points, author,
    grading_review_id, class_id, eff_points, err, should_insert
  )
  SELECT
    (value->>'submission_id')::bigint,
    value->>'comment',
    NULLIF(value->>'rubric_check_id', '')::bigint,
    NULLIF(value->>'points', '')::numeric,
    COALESCE(
      NULLIF(value->>'author', '')::uuid,
      NULLIF(p_authors_by_submission->>(value->>'submission_id'), '')::uuid,
      p_default_author
    ),
    s.grading_review_id,
    s.class_id,
    NULL::numeric,
    NULL::text,
    false
  FROM jsonb_array_elements(p_submission_comments) AS e(value)
  INNER JOIN submissions s ON s.id = (value->>'submission_id')::bigint;

  UPDATE _cli_sc sc
  SET
    err = CASE
      WHEN sc.class_id IS DISTINCT FROM p_class_id OR NOT EXISTS (
        SELECT 1 FROM submissions ss
        WHERE ss.id = sc.submission_id AND ss.assignment_id = p_assignment_id AND ss.class_id = p_class_id
      ) THEN 'submission_not_in_class_assignment'
      WHEN sc.author IS NULL THEN 'missing_author'
      WHEN sc.rubric_check_id IS NOT NULL AND (
        v_rubric_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM rubric_checks rc WHERE rc.id = sc.rubric_check_id AND rc.rubric_id = v_rubric_id)
      ) THEN 'invalid_rubric_check_id'
      ELSE NULL
    END,
    eff_points = coalesce(
      sc.points,
      (SELECT rc.points FROM rubric_checks rc WHERE rc.id = sc.rubric_check_id LIMIT 1)
    )
  WHERE true;

  UPDATE _cli_sc sc
  SET should_insert = (
    sc.err IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM submission_comments c
      WHERE c.submission_id = sc.submission_id
        AND c.deleted_at IS NULL
        AND c.comment IS NOT DISTINCT FROM sc.comment
        AND c.rubric_check_id IS NOT DISTINCT FROM sc.rubric_check_id
    )
  )
  WHERE true;

  UPDATE _cli_sc sc
  SET should_insert = false
  WHERE sc.should_insert
    AND EXISTS (
      SELECT 1 FROM _cli_sc sc2
      WHERE sc2.should_insert
        AND sc2.submission_id = sc.submission_id
        AND sc2.comment IS NOT DISTINCT FROM sc.comment
        AND sc2.rubric_check_id IS NOT DISTINCT FROM sc.rubric_check_id
        AND sc2.ctid < sc.ctid
    );

  SELECT count(*) FILTER (WHERE should_insert) INTO v_sub_ins FROM _cli_sc;
  SELECT count(*) FILTER (
    WHERE err IS NULL AND NOT should_insert
  ) INTO v_sub_skip FROM _cli_sc;
  SELECT count(*) FILTER (WHERE err IS NOT NULL) INTO v_sub_err FROM _cli_sc;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', 'submission_comment',
        'submission_id', sc.submission_id,
        'reason', sc.err
      )
    ),
    '[]'::jsonb
  ) INTO r
  FROM _cli_sc sc
  WHERE sc.err IS NOT NULL;
  v_errs := v_errs || coalesce(r, '[]'::jsonb);

  IF NOT p_dry_run THEN
    INSERT INTO submission_comments (
      submission_id,
      comment,
      points,
      rubric_check_id,
      class_id,
      author,
      released,
      eventually_visible,
      submission_review_id
    )
    SELECT
      sc.submission_id,
      sc.comment,
      sc.eff_points,
      sc.rubric_check_id,
      sc.class_id,
      sc.author,
      false,
      true,
      sc.grading_review_id
    FROM _cli_sc sc
    WHERE sc.should_insert;
  END IF;

  DROP TABLE _cli_sc;

  END IF;

  -- ---------- SYNC (soft-delete) ----------
  IF ((p_mode = 'sync' AND NOT p_skip_sync) OR p_run_sync_only)
     AND coalesce(array_length(v_all_rubric_ids, 1), 0) > 0
     AND coalesce(array_length(v_sync_ids, 1), 0) > 0
     AND NOT p_dry_run THEN

    CREATE TEMP TABLE _cli_exp_file ON COMMIT DROP AS
    SELECT DISTINCT
      (value->>'submission_id')::bigint AS submission_id,
      NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
    FROM jsonb_array_elements(p_file_comments) AS e(value)
    WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL;

    CREATE TEMP TABLE _cli_exp_art ON COMMIT DROP AS
    SELECT DISTINCT
      (value->>'submission_id')::bigint AS submission_id,
      NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
    FROM jsonb_array_elements(p_artifact_comments) AS e(value)
    WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL;

    CREATE TEMP TABLE _cli_exp_sub ON COMMIT DROP AS
    SELECT DISTINCT
      (value->>'submission_id')::bigint AS submission_id,
      NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
    FROM jsonb_array_elements(p_submission_comments) AS e(value)
    WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL;

    WITH expected AS (
      SELECT submission_id, rubric_check_id FROM _cli_exp_file
      UNION
      SELECT submission_id, rubric_check_id FROM _cli_exp_art
      UNION
      SELECT submission_id, rubric_check_id FROM _cli_exp_sub
    )
    UPDATE submission_file_comments sfc
    SET deleted_at = now()
    WHERE sfc.submission_id = ANY (v_sync_ids)
      AND sfc.deleted_at IS NULL
      AND sfc.rubric_check_id IS NOT NULL
      AND sfc.rubric_check_id = ANY (v_all_rubric_ids)
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE e.submission_id = sfc.submission_id
          AND e.rubric_check_id = sfc.rubric_check_id
      );
    GET DIAGNOSTICS v_del_file = ROW_COUNT;

    WITH expected AS (
      SELECT submission_id, rubric_check_id FROM _cli_exp_file
      UNION
      SELECT submission_id, rubric_check_id FROM _cli_exp_art
      UNION
      SELECT submission_id, rubric_check_id FROM _cli_exp_sub
    )
    UPDATE submission_artifact_comments sac
    SET deleted_at = now()
    WHERE sac.submission_id = ANY (v_sync_ids)
      AND sac.deleted_at IS NULL
      AND sac.rubric_check_id IS NOT NULL
      AND sac.rubric_check_id = ANY (v_all_rubric_ids)
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE e.submission_id = sac.submission_id
          AND e.rubric_check_id = sac.rubric_check_id
      );
    GET DIAGNOSTICS v_del_art = ROW_COUNT;

    WITH expected AS (
      SELECT submission_id, rubric_check_id FROM _cli_exp_file
      UNION
      SELECT submission_id, rubric_check_id FROM _cli_exp_art
      UNION
      SELECT submission_id, rubric_check_id FROM _cli_exp_sub
    )
    UPDATE submission_comments sc
    SET deleted_at = now()
    WHERE sc.submission_id = ANY (v_sync_ids)
      AND sc.deleted_at IS NULL
      AND sc.rubric_check_id IS NOT NULL
      AND sc.rubric_check_id = ANY (v_all_rubric_ids)
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE e.submission_id = sc.submission_id
          AND e.rubric_check_id = sc.rubric_check_id
      );
    GET DIAGNOSTICS v_del_sub = ROW_COUNT;

    DROP TABLE _cli_exp_file;
    DROP TABLE _cli_exp_art;
    DROP TABLE _cli_exp_sub;
  ELSIF (p_mode = 'sync' OR p_run_sync_only) AND p_dry_run AND NOT p_skip_sync
    AND coalesce(array_length(v_all_rubric_ids, 1), 0) > 0
    AND coalesce(array_length(v_sync_ids, 1), 0) > 0 THEN
    WITH expected AS (
      SELECT DISTINCT (value->>'submission_id')::bigint AS submission_id,
        NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
      FROM jsonb_array_elements(p_file_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
      UNION
      SELECT DISTINCT (value->>'submission_id')::bigint,
        NULLIF(value->>'rubric_check_id', '')::bigint
      FROM jsonb_array_elements(p_artifact_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
      UNION
      SELECT DISTINCT (value->>'submission_id')::bigint,
        NULLIF(value->>'rubric_check_id', '')::bigint
      FROM jsonb_array_elements(p_submission_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
    )
    SELECT count(*) INTO v_del_file
    FROM submission_file_comments sfc
    WHERE sfc.submission_id = ANY (v_sync_ids)
      AND sfc.deleted_at IS NULL
      AND sfc.rubric_check_id IS NOT NULL
      AND sfc.rubric_check_id = ANY (v_all_rubric_ids)
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE e.submission_id = sfc.submission_id
          AND e.rubric_check_id = sfc.rubric_check_id
      );

    WITH expected AS (
      SELECT DISTINCT (value->>'submission_id')::bigint AS submission_id,
        NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
      FROM jsonb_array_elements(p_file_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
      UNION
      SELECT DISTINCT (value->>'submission_id')::bigint,
        NULLIF(value->>'rubric_check_id', '')::bigint
      FROM jsonb_array_elements(p_artifact_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
      UNION
      SELECT DISTINCT (value->>'submission_id')::bigint,
        NULLIF(value->>'rubric_check_id', '')::bigint
      FROM jsonb_array_elements(p_submission_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
    )
    SELECT count(*) INTO v_del_art
    FROM submission_artifact_comments sac
    WHERE sac.submission_id = ANY (v_sync_ids)
      AND sac.deleted_at IS NULL
      AND sac.rubric_check_id IS NOT NULL
      AND sac.rubric_check_id = ANY (v_all_rubric_ids)
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE e.submission_id = sac.submission_id
          AND e.rubric_check_id = sac.rubric_check_id
      );

    WITH expected AS (
      SELECT DISTINCT (value->>'submission_id')::bigint AS submission_id,
        NULLIF(value->>'rubric_check_id', '')::bigint AS rubric_check_id
      FROM jsonb_array_elements(p_file_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
      UNION
      SELECT DISTINCT (value->>'submission_id')::bigint,
        NULLIF(value->>'rubric_check_id', '')::bigint
      FROM jsonb_array_elements(p_artifact_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
      UNION
      SELECT DISTINCT (value->>'submission_id')::bigint,
        NULLIF(value->>'rubric_check_id', '')::bigint
      FROM jsonb_array_elements(p_submission_comments) AS e(value)
      WHERE NULLIF(value->>'rubric_check_id', '') IS NOT NULL
    )
    SELECT count(*) INTO v_del_sub
    FROM submission_comments sc
    WHERE sc.submission_id = ANY (v_sync_ids)
      AND sc.deleted_at IS NULL
      AND sc.rubric_check_id IS NOT NULL
      AND sc.rubric_check_id = ANY (v_all_rubric_ids)
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE e.submission_id = sc.submission_id
          AND e.rubric_check_id = sc.rubric_check_id
      );
  END IF;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'mode', p_mode,
    'summary', jsonb_build_object(
      'file_comments', jsonb_build_object(
        'inserted', v_file_ins,
        'skipped', v_file_skip,
        'errors', v_file_err
      ),
      'artifact_comments', jsonb_build_object(
        'inserted', v_art_ins,
        'skipped', v_art_skip,
        'errors', v_art_err
      ),
      'submission_comments', jsonb_build_object(
        'inserted', v_sub_ins,
        'skipped', v_sub_skip,
        'errors', v_sub_err
      ),
      'sync_deleted', jsonb_build_object(
        'file_comments', v_del_file,
        'artifact_comments', v_del_art,
        'submission_comments', v_del_sub
      )
    ),
    'errors_detail', coalesce(v_errs, '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.cli_import_submission_comments_batch(
  bigint, bigint, text, boolean, jsonb, jsonb, jsonb, bigint[], uuid, jsonb, boolean, boolean
) IS 'Batch import/sync submission comments for CLI edge function; service_role only. Import skips duplicate active rows matching file/line/body/rubric_check (or artifact/submission equivalents). Comment points are numeric.';
