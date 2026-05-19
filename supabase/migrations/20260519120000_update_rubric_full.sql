-- Single-shot rubric update RPC.
--
-- Replaces the multi-row save flow in app/.../rubric/page.tsx (which used per-row
-- updateResource/createResource/deleteResource and relied on a per-check trigger
-- to recompute scores). The frontend now sends the entire hydrated rubric tree
-- in one call; this function diffs against the DB, applies all changes, cascades
-- check.points to existing comments, and recomputes only the affected
-- submission_reviews. Returns a friendly summary string the frontend toasts.
--
-- Note: the name avoids `atomic` because the supabase-cli SQL splitter treats
-- it as the `BEGIN ATOMIC` SQL-function keyword and bundles every trailing
-- statement into a single prepared statement, which Postgres then rejects with
-- "cannot insert multiple commands into a prepared statement".
--
-- "Affected" decomposes into:
--   - "targeted": only reviews holding comments on a check whose points changed
--     or that was removed. Used when no broader changes happened.
--   - "broad": every submission_review on the rubric. Triggered by anything that
--     can shift max-score math elsewhere (criterion total_points / is_additive /
--     is_deduction_only changes; criterion or check adds; rubric.cap toggle;
--     creating a brand-new rubric).

DROP TRIGGER IF EXISTS on_rubric_check_points_updated ON public.rubric_checks;
DROP FUNCTION IF EXISTS public.handle_rubric_check_points_update();

CREATE OR REPLACE FUNCTION public.update_rubric_full(p_rubric jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  v_new_name text;
  v_new_description text;
  v_new_is_private boolean;
  v_new_cap boolean;

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

  -- Input id (negative or 0 = new) -> real DB id, after insert/update phases.
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

  -- Checks whose `points` value changed -> cascade to comments + targeted recompute.
  v_points_changed_check_ids bigint[] := ARRAY[]::bigint[];
  -- Checks removed in this call (so we can credit "targeted" reviews on them).
  v_removed_check_ids bigint[] := ARRAY[]::bigint[];

  -- Final set of reviews to recompute.
  v_affected_review_ids bigint[] := ARRAY[]::bigint[];

  -- Scratch slots for old-vs-new comparisons, hoisted to the top so the function
  -- body has no nested DECLARE blocks (which the supabase-cli SQL splitter mishandles).
  v_old_total_points int;
  v_old_is_additive boolean;
  v_old_is_deduction_only boolean;
  v_old_points int;

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
  -- Rubric shell: create or load + update top-level fields.
  ----------------------------------------------------------------
  IF v_rubric_id IS NULL THEN
    INSERT INTO public.rubrics (
      name, description, assignment_id, class_id, is_private, review_round,
      cap_score_to_assignment_points
    )
    VALUES (
      v_new_name, v_new_description, v_assignment_id, v_class_id, v_new_is_private,
      v_review_round, v_new_cap
    )
    RETURNING id INTO v_rubric_id;
    v_is_new_rubric := true;
    v_broad_change := true;  -- brand new rubric: nothing to recompute against, but be defensive.
  ELSE
    SELECT name, description, is_private, cap_score_to_assignment_points
    INTO v_old_name, v_old_description, v_old_is_private, v_old_cap
    FROM public.rubrics
    WHERE id = v_rubric_id AND class_id = v_class_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rubric % not found in class %', v_rubric_id, v_class_id;
    END IF;

    IF v_old_name IS DISTINCT FROM v_new_name
       OR v_old_description IS DISTINCT FROM v_new_description
       OR v_old_is_private IS DISTINCT FROM v_new_is_private
       OR v_old_cap IS DISTINCT FROM v_new_cap THEN
      UPDATE public.rubrics
      SET name = v_new_name,
          description = v_new_description,
          is_private = v_new_is_private,
          cap_score_to_assignment_points = v_new_cap
      WHERE id = v_rubric_id;
    END IF;

    IF v_old_cap IS DISTINCT FROM v_new_cap THEN
      v_broad_change := true;  -- cap toggle changes capping inside _submission_review_recompute_scores.
    END IF;
  END IF;

  ----------------------------------------------------------------
  -- Phase 1: parts. Cascading delete also removes criteria + checks tied to the part,
  -- so we count those into v_*_removed via FK cascade triggers below.
  ----------------------------------------------------------------
  WITH input_ids AS (
    SELECT (elem->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) elem
    WHERE COALESCE((elem->>'id')::bigint, 0) > 0
  ),
  del AS (
    DELETE FROM public.rubric_parts
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_parts_removed FROM del;

  IF v_parts_removed > 0 THEN
    v_broad_change := true;
  END IF;

  FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb))
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);

    IF v_input_part_id <= 0 THEN
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

      v_part_id_map := v_part_id_map || jsonb_build_object(v_input_part_id::text, v_part_id);
      v_parts_added := v_parts_added + 1;
      v_broad_change := true;
    ELSE
      UPDATE public.rubric_parts
      SET name = v_part->>'name',
          description = v_part->>'description',
          ordinal = COALESCE((v_part->>'ordinal')::int, 0),
          data = v_part->'data',
          is_individual_grading = COALESCE((v_part->>'is_individual_grading')::boolean, false),
          is_assign_to_student = COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      WHERE id = v_input_part_id AND rubric_id = v_rubric_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Part % not in rubric %', v_input_part_id, v_rubric_id;
      END IF;

      v_part_id_map := v_part_id_map || jsonb_build_object(v_input_part_id::text, v_input_part_id);
      v_parts_updated := v_parts_updated + 1;
    END IF;
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 2: criteria.
  ----------------------------------------------------------------
  WITH input_ids AS (
    SELECT (crit->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit
    WHERE COALESCE((crit->>'id')::bigint, 0) > 0
  ),
  del AS (
    DELETE FROM public.rubric_criteria
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_criteria_removed FROM del;

  IF v_criteria_removed > 0 THEN
    v_broad_change := true;
  END IF;

  FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb))
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    v_part_id := COALESCE((v_part_id_map->>v_input_part_id::text)::bigint, v_input_part_id);

    FOR v_criterion IN SELECT * FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb))
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);

      IF v_input_criteria_id <= 0 THEN
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

        v_criteria_id_map := v_criteria_id_map || jsonb_build_object(v_input_criteria_id::text, v_criteria_id);
        v_criteria_added := v_criteria_added + 1;
        v_broad_change := true;
      ELSE
        -- Detect scoring-shape changes so we can flag broad recompute.
        SELECT total_points, is_additive, is_deduction_only
        INTO v_old_total_points, v_old_is_additive, v_old_is_deduction_only
        FROM public.rubric_criteria WHERE id = v_input_criteria_id;

        IF v_old_total_points IS DISTINCT FROM COALESCE((v_criterion->>'total_points')::int, 0)
           OR v_old_is_additive IS DISTINCT FROM COALESCE((v_criterion->>'is_additive')::boolean, false)
           OR v_old_is_deduction_only IS DISTINCT FROM COALESCE((v_criterion->>'is_deduction_only')::boolean, false) THEN
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

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Criterion % not in rubric %', v_input_criteria_id, v_rubric_id;
        END IF;

        v_criteria_id_map := v_criteria_id_map || jsonb_build_object(v_input_criteria_id::text, v_input_criteria_id);
        v_criteria_updated := v_criteria_updated + 1;
      END IF;
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 3: checks. Track removed ids and ids whose `points` changed so we can
  -- collect targeted reviews and cascade points to existing comments.
  ----------------------------------------------------------------
  WITH input_ids AS (
    SELECT (chk->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
         jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk
    WHERE COALESCE((chk->>'id')::bigint, 0) > 0
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_removed_check_ids
  FROM public.rubric_checks
  WHERE rubric_id = v_rubric_id
    AND id NOT IN (SELECT id FROM input_ids);

  IF array_length(v_removed_check_ids, 1) > 0 THEN
    DELETE FROM public.rubric_checks WHERE id = ANY(v_removed_check_ids);
    v_checks_removed := array_length(v_removed_check_ids, 1);
    v_broad_change := true;  -- a removed check changes the per-criterion check pool.
  END IF;

  FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb))
  LOOP
    FOR v_criterion IN SELECT * FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb))
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      v_criteria_id := COALESCE((v_criteria_id_map->>v_input_criteria_id::text)::bigint, v_input_criteria_id);

      FOR v_check IN SELECT * FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb))
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);

        IF v_input_check_id <= 0 THEN
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
            COALESCE((v_check->>'points')::int, 0),
            v_check->>'annotation_target',
            COALESCE((v_check->>'student_visibility')::rubric_check_student_visibility, 'always'::rubric_check_student_visibility),
            NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          ) RETURNING id INTO v_check_id;

          v_check_id_map := v_check_id_map || jsonb_build_object(v_input_check_id::text, v_check_id);
          v_checks_added := v_checks_added + 1;
          v_broad_change := true;
        ELSE
          SELECT points INTO v_old_points
          FROM public.rubric_checks WHERE id = v_input_check_id;

          IF v_old_points IS DISTINCT FROM COALESCE((v_check->>'points')::int, 0) THEN
            v_points_changed_check_ids := array_append(v_points_changed_check_ids, v_input_check_id);
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
              points = COALESCE((v_check->>'points')::int, 0),
              annotation_target = v_check->>'annotation_target',
              student_visibility = COALESCE(
                (v_check->>'student_visibility')::rubric_check_student_visibility,
                'always'::rubric_check_student_visibility
              ),
              kpi_category = NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          WHERE id = v_input_check_id AND rubric_id = v_rubric_id;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'Check % not in rubric %', v_input_check_id, v_rubric_id;
          END IF;

          v_check_id_map := v_check_id_map || jsonb_build_object(v_input_check_id::text, v_input_check_id);
          v_checks_updated := v_checks_updated + 1;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  -- Cascade rubric_checks.points changes to existing comments. The recompute SQL
  -- sums comments.points (not check.points) so without this cascade, edits to
  -- check.points wouldn't affect already-graded submissions.
  ----------------------------------------------------------------
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
  -- Phase 4: rubric_check_references (idempotent diff).
  -- Frontend resolves references to (referencing_check_id, referenced_check_id)
  -- pairs and attaches them to checks. We collect the desired set, diff against
  -- existing rows owned by this rubric, then insert/delete.
  ----------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _desired_refs (
    referencing_check_id bigint NOT NULL,
    referenced_check_id bigint NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE _desired_refs;

  FOR v_part IN SELECT * FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb))
  LOOP
    FOR v_criterion IN SELECT * FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb))
    LOOP
      FOR v_check IN SELECT * FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb))
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);
        v_check_id := COALESCE((v_check_id_map->>v_input_check_id::text)::bigint, v_input_check_id);

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

  ----------------------------------------------------------------
  -- Decide affected submission_reviews and recompute.
  ----------------------------------------------------------------
  IF v_is_new_rubric THEN
    -- Brand new rubric has no submissions graded against it yet.
    v_affected_review_ids := ARRAY[]::bigint[];
  ELSIF v_broad_change THEN
    SELECT COALESCE(array_agg(DISTINCT sr.id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM public.submission_reviews sr
    WHERE sr.rubric_id = v_rubric_id;
  ELSE
    -- Targeted: only reviews holding comments on changed-points or removed checks.
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

  ----------------------------------------------------------------
  -- Build friendly summary.
  ----------------------------------------------------------------
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
  'Atomically apply a hydrated rubric (top-level fields + parts/criteria/checks/references) in one transaction, cascade points changes to existing comments, recompute affected submission_reviews, and return a friendly summary. Replaces the per-row save flow + on_rubric_check_points_updated trigger.';

REVOKE ALL ON FUNCTION public.update_rubric_full(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.update_rubric_full(jsonb) TO authenticated;
