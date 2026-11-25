-- Instructor-facing workflow for deleting rubric checks that may have been applied to submissions.
--
-- Previously, Phase 0 of update_rubric_full ran `DELETE FROM public.rubric_checks` directly,
-- failing with SQLSTATE 23503 (foreign_key_violation) whenever any row in:
--   - public.submission_comments
--   - public.submission_file_comments
--   - public.submission_artifact_comments
--   - public.submission_regrade_requests
-- still referenced the check (including already-soft-deleted comments whose deleted_at IS NOT NULL).
--
-- This migration:
--   1. Relaxes submission_regrade_requests_target_check narrowly so bare-check regrade requests
--      whose rubric check was deleted retain their history after rubric_check_id is cleared.
--   2. Adds internal helper public._collect_rubric_check_usage(...) to collect active applications
--      (across all three comment tables + active bare-check regrade requests) with real grader
--      identities resolved via user_roles even under pseudonymous grading.
--   3. Adds public.preview_rubric_check_deletions(p_rubric_id, p_removed_check_ids) so the rubric
--      editor can inspect affected submissions and graders before confirming deletion.
--   4. Adds public.update_rubric_full_with_report(p_rubric, p_confirm_delete_check_ids,
--      p_previewed_at, p_expected_active_comment_count) which:
--        - refuses with 23503 (HINT = 'rubric_checks_in_use') if any removed check has active
--          comments or active bare-check regrade requests that were not confirmed (or if new
--          applications arrived since preview);
--        - snapshots the ground-truth deleted_checks_report before mutating;
--        - soft-deletes confirmed active comments (deleted_at = now(), edited_at = now(),
--          edited_by = actor, rubric_check_id = NULL) so audit logs, regrade auto-resolution,
--          and realtime broadcasts all fire;
--        - clears rubric_check_id = NULL on already-soft-deleted comments and detaches/resolves
--          regrade requests so unused checks with only soft-deleted comments delete cleanly;
--        - returns { summary, deleted_checks_report }.
--   5. Keeps public.update_rubric_full(p_rubric jsonb) RETURNS text as a thin backwards-compatible
--      wrapper around update_rubric_full_with_report (for CLI and existing callers).

-- ---------------------------------------------------------------------------
-- 1. Allow historical bare-check regrade requests to outlive a deleted check
-- ---------------------------------------------------------------------------
ALTER TABLE public.submission_regrade_requests
  DROP CONSTRAINT IF EXISTS submission_regrade_requests_target_check;

ALTER TABLE public.submission_regrade_requests
  ADD CONSTRAINT submission_regrade_requests_target_check CHECK (
    (
      (submission_file_comment_id IS NOT NULL)::int +
      (submission_comment_id IS NOT NULL)::int +
      (submission_artifact_comment_id IS NOT NULL)::int
    ) <= 1
    AND (
      submission_file_comment_id IS NOT NULL
      OR submission_comment_id IS NOT NULL
      OR submission_artifact_comment_id IS NOT NULL
      OR rubric_check_id IS NOT NULL
      OR status IN ('resolved', 'closed')
      OR resolution_reason = 'rubric_check_deleted'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Internal helper: collect active usage for a set of rubric checks
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._collect_rubric_check_usage(
  p_rubric_id bigint,
  p_class_id bigint,
  p_check_ids bigint[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH target_checks AS (
    SELECT
      rc.id AS check_id,
      rc.name AS check_name,
      rc.points AS check_points,
      rc.ordinal AS check_ordinal,
      rcr.id AS criterion_id,
      rcr.name AS criterion_name,
      rcr.ordinal AS criterion_ordinal,
      rp.id AS part_id,
      rp.name AS part_name,
      rp.ordinal AS part_ordinal
    FROM public.rubric_checks rc
    JOIN public.rubric_criteria rcr ON rcr.id = rc.rubric_criteria_id
    JOIN public.rubric_parts rp ON rp.id = rcr.rubric_part_id
    WHERE rc.rubric_id = p_rubric_id
      AND rc.class_id = p_class_id
      AND rc.id = ANY(COALESCE(p_check_ids, ARRAY[]::bigint[]))
  ),
  raw_comments AS (
    SELECT
      sc.rubric_check_id AS check_id,
      sc.id AS comment_id,
      'submission'::text AS comment_type,
      sc.submission_id,
      sc.submission_review_id,
      sc.author,
      sc.points,
      sc.comment AS comment_text,
      sc.created_at,
      NULL::text AS file_name,
      NULL::int AS line,
      NULL::text AS artifact_name
    FROM public.submission_comments sc
    WHERE sc.rubric_check_id IN (SELECT check_id FROM target_checks)
      AND sc.deleted_at IS NULL

    UNION ALL

    SELECT
      sfc.rubric_check_id AS check_id,
      sfc.id AS comment_id,
      'file'::text AS comment_type,
      sfc.submission_id,
      sfc.submission_review_id,
      sfc.author,
      sfc.points,
      sfc.comment AS comment_text,
      sfc.created_at,
      sf.name AS file_name,
      sfc.line,
      NULL::text AS artifact_name
    FROM public.submission_file_comments sfc
    LEFT JOIN public.submission_files sf ON sf.id = sfc.submission_file_id
    WHERE sfc.rubric_check_id IN (SELECT check_id FROM target_checks)
      AND sfc.deleted_at IS NULL

    UNION ALL

    SELECT
      sac.rubric_check_id AS check_id,
      sac.id AS comment_id,
      'artifact'::text AS comment_type,
      sac.submission_id,
      sac.submission_review_id,
      sac.author,
      sac.points,
      sac.comment AS comment_text,
      sac.created_at,
      NULL::text AS file_name,
      NULL::int AS line,
      sa.name AS artifact_name
    FROM public.submission_artifact_comments sac
    LEFT JOIN public.submission_artifacts sa ON sa.id = sac.submission_artifact_id
    WHERE sac.rubric_check_id IN (SELECT check_id FROM target_checks)
      AND sac.deleted_at IS NULL
  ),
  enriched_comments AS (
    SELECT
      rc.check_id,
      rc.comment_id,
      rc.comment_type,
      rc.submission_id,
      s.ordinal AS submission_ordinal,
      COALESCE(s.is_active, false) AS is_active,
      COALESCE(ag.name, sp.name, 'Unknown') AS student_or_group_name,
      (s.assignment_group_id IS NOT NULL) AS is_group,
      rc.submission_review_id,
      COALESCE(sr.released, false) AS review_released,
      COALESCE(gr_ur.private_profile_id, rc.author) AS grader_profile_id,
      COALESCE(gr_priv.name, gr_raw.name, 'Unknown') AS grader_name,
      gr_u.email AS grader_email,
      rc.file_name,
      rc.line,
      rc.artifact_name,
      rc.points,
      rc.comment_text,
      rc.created_at
    FROM raw_comments rc
    JOIN public.submissions s ON s.id = rc.submission_id
    LEFT JOIN public.profiles sp ON sp.id = s.profile_id
    LEFT JOIN public.assignment_groups ag ON ag.id = s.assignment_group_id
    LEFT JOIN public.submission_reviews sr ON sr.id = rc.submission_review_id
    LEFT JOIN LATERAL (
      SELECT ur.private_profile_id, ur.user_id
      FROM public.user_roles ur
      WHERE ur.class_id = p_class_id
        AND (ur.private_profile_id = rc.author OR ur.public_profile_id = rc.author)
      ORDER BY ur.disabled ASC, ur.id ASC
      LIMIT 1
    ) gr_ur ON true
    LEFT JOIN public.profiles gr_priv ON gr_priv.id = COALESCE(gr_ur.private_profile_id, rc.author)
    LEFT JOIN public.profiles gr_raw ON gr_raw.id = rc.author
    LEFT JOIN public.users gr_u ON gr_u.user_id = gr_ur.user_id
  ),
  active_regrades_by_check AS (
    SELECT
      check_id,
      count(DISTINCT regrade_request_id)::int AS active_regrade_request_count
    FROM (
      SELECT srr.rubric_check_id AS check_id, srr.id AS regrade_request_id
      FROM public.submission_regrade_requests srr
      WHERE srr.rubric_check_id IN (SELECT check_id FROM target_checks)
        AND srr.status IN ('draft', 'opened', 'escalated')

      UNION

      SELECT sc.rubric_check_id AS check_id, srr.id AS regrade_request_id
      FROM public.submission_regrade_requests srr
      JOIN public.submission_comments sc ON sc.id = srr.submission_comment_id
      WHERE sc.rubric_check_id IN (SELECT check_id FROM target_checks)
        AND sc.deleted_at IS NULL
        AND srr.status IN ('draft', 'opened', 'escalated')

      UNION

      SELECT sfc.rubric_check_id AS check_id, srr.id AS regrade_request_id
      FROM public.submission_regrade_requests srr
      JOIN public.submission_file_comments sfc ON sfc.id = srr.submission_file_comment_id
      WHERE sfc.rubric_check_id IN (SELECT check_id FROM target_checks)
        AND sfc.deleted_at IS NULL
        AND srr.status IN ('draft', 'opened', 'escalated')

      UNION

      SELECT sac.rubric_check_id AS check_id, srr.id AS regrade_request_id
      FROM public.submission_regrade_requests srr
      JOIN public.submission_artifact_comments sac ON sac.id = srr.submission_artifact_comment_id
      WHERE sac.rubric_check_id IN (SELECT check_id FROM target_checks)
        AND sac.deleted_at IS NULL
        AND srr.status IN ('draft', 'opened', 'escalated')
    ) all_regrades
    GROUP BY check_id
  ),
  bare_regrades AS (
    SELECT
      srr.rubric_check_id AS check_id,
      srr.id AS regrade_request_id,
      srr.submission_id,
      s.ordinal AS submission_ordinal,
      COALESCE(ag.name, sp.name, 'Unknown') AS student_or_group_name,
      srr.status::text AS status,
      COALESCE(asg_ur.private_profile_id, srr.assignee) AS assignee_profile_id,
      COALESCE(asg_priv.name, asg_raw.name, 'Unknown') AS assignee_name,
      asg_u.email AS assignee_email
    FROM public.submission_regrade_requests srr
    JOIN public.submissions s ON s.id = srr.submission_id
    LEFT JOIN public.profiles sp ON sp.id = s.profile_id
    LEFT JOIN public.assignment_groups ag ON ag.id = s.assignment_group_id
    LEFT JOIN LATERAL (
      SELECT ur.private_profile_id, ur.user_id
      FROM public.user_roles ur
      WHERE ur.class_id = p_class_id
        AND (ur.private_profile_id = srr.assignee OR ur.public_profile_id = srr.assignee)
      ORDER BY ur.disabled ASC, ur.id ASC
      LIMIT 1
    ) asg_ur ON true
    LEFT JOIN public.profiles asg_priv ON asg_priv.id = COALESCE(asg_ur.private_profile_id, srr.assignee)
    LEFT JOIN public.profiles asg_raw ON asg_raw.id = srr.assignee
    LEFT JOIN public.users asg_u ON asg_u.user_id = asg_ur.user_id
    WHERE srr.rubric_check_id IN (SELECT check_id FROM target_checks)
      AND srr.submission_comment_id IS NULL
      AND srr.submission_file_comment_id IS NULL
      AND srr.submission_artifact_comment_id IS NULL
      AND srr.status IN ('draft', 'opened', 'escalated')
  ),
  per_check_stats AS (
    SELECT
      tc.check_id,
      tc.check_name,
      tc.check_points,
      tc.check_ordinal,
      tc.criterion_id,
      tc.criterion_name,
      tc.criterion_ordinal,
      tc.part_id,
      tc.part_name,
      tc.part_ordinal,
      COALESCE((SELECT count(DISTINCT ec.submission_id)::int FROM enriched_comments ec WHERE ec.check_id = tc.check_id), 0) AS submission_count,
      COALESCE((SELECT count(*)::int FROM enriched_comments ec WHERE ec.check_id = tc.check_id), 0) AS comment_count,
      COALESCE((SELECT count(DISTINCT ec.submission_id)::int FROM enriched_comments ec WHERE ec.check_id = tc.check_id AND ec.review_released), 0) AS released_submission_count,
      COALESCE(ar.active_regrade_request_count, 0) AS active_regrade_request_count,
      COALESCE((SELECT count(*)::int FROM bare_regrades br WHERE br.check_id = tc.check_id), 0) AS bare_regrade_request_count,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'submission_id', ec.submission_id,
              'submission_ordinal', ec.submission_ordinal,
              'is_active', ec.is_active,
              'student_or_group_name', ec.student_or_group_name,
              'is_group', ec.is_group,
              'submission_review_id', ec.submission_review_id,
              'review_released', ec.review_released,
              'grader_profile_id', ec.grader_profile_id,
              'grader_name', ec.grader_name,
              'grader_email', ec.grader_email,
              'comment_id', ec.comment_id,
              'comment_type', ec.comment_type,
              'file_name', ec.file_name,
              'line', ec.line,
              'artifact_name', ec.artifact_name,
              'points', ec.points,
              'comment_text', ec.comment_text,
              'created_at', ec.created_at
            )
            ORDER BY ec.student_or_group_name, ec.submission_id, ec.created_at, ec.comment_id
          )
          FROM enriched_comments ec
          WHERE ec.check_id = tc.check_id
        ),
        '[]'::jsonb
      ) AS applications,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'regrade_request_id', br.regrade_request_id,
              'submission_id', br.submission_id,
              'submission_ordinal', br.submission_ordinal,
              'student_or_group_name', br.student_or_group_name,
              'status', br.status,
              'assignee_profile_id', br.assignee_profile_id,
              'assignee_name', br.assignee_name,
              'assignee_email', br.assignee_email
            )
            ORDER BY br.student_or_group_name, br.submission_id, br.regrade_request_id
          )
          FROM bare_regrades br
          WHERE br.check_id = tc.check_id
        ),
        '[]'::jsonb
      ) AS bare_regrade_requests
    FROM target_checks tc
    LEFT JOIN active_regrades_by_check ar ON ar.check_id = tc.check_id
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'check_id', s.check_id,
        'check_name', s.check_name,
        'check_points', s.check_points,
        'criterion_id', s.criterion_id,
        'criterion_name', s.criterion_name,
        'part_id', s.part_id,
        'part_name', s.part_name,
        'submission_count', s.submission_count,
        'comment_count', s.comment_count,
        'released_submission_count', s.released_submission_count,
        'active_regrade_request_count', s.active_regrade_request_count,
        'bare_regrade_request_count', s.bare_regrade_request_count,
        'applications', s.applications,
        'bare_regrade_requests', s.bare_regrade_requests
      )
      ORDER BY s.part_ordinal, s.criterion_ordinal, s.check_ordinal, s.check_id
    ),
    '[]'::jsonb
  )
  FROM per_check_stats s
  WHERE s.comment_count > 0 OR s.bare_regrade_request_count > 0;
$function$;

REVOKE ALL ON FUNCTION public._collect_rubric_check_usage(bigint, bigint, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._collect_rubric_check_usage(bigint, bigint, bigint[]) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Public preview RPC for the rubric editor save flow
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_rubric_check_deletions(
  p_rubric_id bigint,
  p_removed_check_ids bigint[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_class_id bigint;
  v_checks jsonb;
BEGIN
  IF p_rubric_id IS NULL THEN
    RAISE EXCEPTION 'p_rubric_id is required';
  END IF;

  SELECT r.class_id INTO v_class_id
  FROM public.rubrics r
  WHERE r.id = p_rubric_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rubric % not found', p_rubric_id;
  END IF;

  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_rubrics')) THEN
    RAISE EXCEPTION 'Not authorized to inspect rubric check usage in this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_removed_check_ids IS NULL OR COALESCE(array_length(p_removed_check_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object(
      'previewed_at', now(),
      'checks', '[]'::jsonb
    );
  END IF;

  v_checks := public._collect_rubric_check_usage(p_rubric_id, v_class_id, p_removed_check_ids);

  RETURN jsonb_build_object(
    'previewed_at', now(),
    'checks', v_checks
  );
END;
$function$;

COMMENT ON FUNCTION public.preview_rubric_check_deletions(bigint, bigint[]) IS
  'Returns active comment applications and active bare-check regrade requests for rubric checks slated for deletion, with real grader identities resolved via user_roles. Requires manage_rubrics.';

REVOKE ALL ON FUNCTION public.preview_rubric_check_deletions(bigint, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_rubric_check_deletions(bigint, bigint[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Atomic rubric save with confirmed applied-check deletion & report
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_rubric_full_with_report(
  p_rubric jsonb,
  p_confirm_delete_check_ids bigint[] DEFAULT ARRAY[]::bigint[],
  p_previewed_at timestamptz DEFAULT NULL,
  p_expected_active_comment_count int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '3min'
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
  v_old_review_round review_round;
  v_link_round review_round;
  v_linked_rubric_id bigint;
  v_link_rows int := 0;

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
  v_comments_deleted int := 0;
  v_tmp_count int := 0;
  v_refs_added int := 0;
  v_refs_removed int := 0;
  v_reviews_recomputed int := 0;
  v_foreign_ids_remapped int := 0;
  v_ref_ids bigint[];

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
  v_in_use_check_ids bigint[] := ARRAY[]::bigint[];
  v_affected_review_ids bigint[] := ARRAY[]::bigint[];
  v_actual_active_comment_count int := 0;
  v_has_newer_activity boolean := false;
  v_actor_profile_id uuid;
  v_deleted_checks_report jsonb := NULL;

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
  v_new_hide_unless_assigned := CASE
    WHEN p_rubric ? 'hide_unless_assigned'
    THEN (p_rubric->>'hide_unless_assigned')::boolean
  END;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'class_id is required';
  END IF;
  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_rubrics')) THEN
    RAISE EXCEPTION 'Not authorized to edit rubrics in this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.assignments a WHERE a.id = v_assignment_id AND a.class_id = v_class_id
  ) THEN
    RAISE EXCEPTION 'Assignment % does not belong to class %', v_assignment_id, v_class_id;
  END IF;
  IF v_new_name IS NULL OR length(trim(v_new_name)) = 0 THEN
    RAISE EXCEPTION 'Rubric name is required';
  END IF;

  SELECT ur.private_profile_id
  INTO v_actor_profile_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.class_id = v_class_id
    AND ur.disabled = false
  ORDER BY ur.id ASC
  LIMIT 1;

  SELECT array_agg(DISTINCT (ref->>'referenced_rubric_check_id')::bigint)
  INTO v_ref_ids
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
       jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk,
       jsonb_array_elements(COALESCE(chk->'references', '[]'::jsonb)) ref
  WHERE ref->>'referenced_rubric_check_id' IS NOT NULL;

  IF v_ref_ids IS NOT NULL AND cardinality(v_ref_ids) <> (
    SELECT count(*) FROM public.rubric_checks rc
    WHERE rc.id = ANY (v_ref_ids) AND rc.class_id = v_class_id
  ) THEN
    RAISE EXCEPTION 'Referenced rubric check does not belong to class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  ----------------------------------------------------------------
  -- Reject negative points before touching anything.
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
           assignment_id, review_round
    INTO v_old_name, v_old_description, v_old_is_private, v_old_cap, v_old_hide_unless_assigned,
         v_old_assignment_id, v_old_review_round
    FROM public.rubrics
    WHERE id = v_rubric_id AND class_id = v_class_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rubric % not found in class %', v_rubric_id, v_class_id;
    END IF;

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

  v_link_round := CASE WHEN v_is_new_rubric THEN v_review_round ELSE v_old_review_round END;
  IF v_assignment_id IS NOT NULL
     AND v_link_round IN ('grading-review', 'self-review', 'meta-grading-review') THEN
    SELECT CASE v_link_round
             WHEN 'grading-review' THEN a.grading_rubric_id
             WHEN 'self-review' THEN a.self_review_rubric_id
             ELSE a.meta_grading_rubric_id
           END
    INTO v_linked_rubric_id
    FROM public.assignments a
    WHERE a.id = v_assignment_id;

    IF v_linked_rubric_id IS NULL THEN
      CASE v_link_round
        WHEN 'grading-review' THEN
          UPDATE public.assignments SET grading_rubric_id = v_rubric_id
          WHERE id = v_assignment_id AND grading_rubric_id IS NULL;
          GET DIAGNOSTICS v_link_rows = ROW_COUNT;
        WHEN 'self-review' THEN
          UPDATE public.assignments SET self_review_rubric_id = v_rubric_id
          WHERE id = v_assignment_id AND self_review_rubric_id IS NULL;
          GET DIAGNOSTICS v_link_rows = ROW_COUNT;
        ELSE
          UPDATE public.assignments SET meta_grading_rubric_id = v_rubric_id
          WHERE id = v_assignment_id AND meta_grading_rubric_id IS NULL;
          GET DIAGNOSTICS v_link_rows = ROW_COUNT;
      END CASE;
    END IF;

    IF v_is_new_rubric AND v_link_rows = 0 THEN
      RAISE EXCEPTION 'A rubric for this round was just created by someone else, so your changes weren''t saved. Copy your unsaved YAML before reloading the page to edit it.'
        USING ERRCODE = 'unique_violation', HINT = 'rubric_round_conflict';
    END IF;
  END IF;

  ----------------------------------------------------------------
  -- Phase 0: deletes (leaf -> root).
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
    -- Identify which removed checks currently have active comments or active bare-check regrade requests.
    WITH active_usage AS (
      SELECT rubric_check_id AS id FROM public.submission_comments
      WHERE rubric_check_id = ANY(v_removed_check_ids) AND deleted_at IS NULL
      UNION
      SELECT rubric_check_id AS id FROM public.submission_file_comments
      WHERE rubric_check_id = ANY(v_removed_check_ids) AND deleted_at IS NULL
      UNION
      SELECT rubric_check_id AS id FROM public.submission_artifact_comments
      WHERE rubric_check_id = ANY(v_removed_check_ids) AND deleted_at IS NULL
      UNION
      SELECT rubric_check_id AS id FROM public.submission_regrade_requests
      WHERE rubric_check_id = ANY(v_removed_check_ids)
        AND submission_comment_id IS NULL
        AND submission_file_comment_id IS NULL
        AND submission_artifact_comment_id IS NULL
        AND status IN ('draft', 'opened', 'escalated')
    )
    SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_in_use_check_ids
    FROM active_usage;

    IF array_length(v_in_use_check_ids, 1) > 0 THEN
      -- Every in-use check must have been explicitly confirmed by the caller.
      IF NOT (v_in_use_check_ids <@ COALESCE(p_confirm_delete_check_ids, ARRAY[]::bigint[])) THEN
        RAISE EXCEPTION 'One or more rubric checks being deleted are currently applied to submissions. Review affected submissions and confirm deletion.'
          USING ERRCODE = 'foreign_key_violation', HINT = 'rubric_checks_in_use';
      END IF;

      -- Guard against new comments or bare-check regrade requests arriving after preview.
      SELECT
        (SELECT count(*)::int FROM public.submission_comments WHERE rubric_check_id = ANY(v_in_use_check_ids) AND deleted_at IS NULL) +
        (SELECT count(*)::int FROM public.submission_file_comments WHERE rubric_check_id = ANY(v_in_use_check_ids) AND deleted_at IS NULL) +
        (SELECT count(*)::int FROM public.submission_artifact_comments WHERE rubric_check_id = ANY(v_in_use_check_ids) AND deleted_at IS NULL)
      INTO v_actual_active_comment_count;

      IF p_previewed_at IS NOT NULL THEN
        SELECT (
          EXISTS (SELECT 1 FROM public.submission_comments WHERE rubric_check_id = ANY(v_in_use_check_ids) AND deleted_at IS NULL AND created_at > p_previewed_at)
          OR EXISTS (SELECT 1 FROM public.submission_file_comments WHERE rubric_check_id = ANY(v_in_use_check_ids) AND deleted_at IS NULL AND created_at > p_previewed_at)
          OR EXISTS (SELECT 1 FROM public.submission_artifact_comments WHERE rubric_check_id = ANY(v_in_use_check_ids) AND deleted_at IS NULL AND created_at > p_previewed_at)
          OR EXISTS (
            SELECT 1 FROM public.submission_regrade_requests
            WHERE rubric_check_id = ANY(v_in_use_check_ids)
              AND submission_comment_id IS NULL
              AND submission_file_comment_id IS NULL
              AND submission_artifact_comment_id IS NULL
              AND status IN ('draft', 'opened', 'escalated')
              AND created_at > p_previewed_at
          )
        ) INTO v_has_newer_activity;
      END IF;

      IF v_has_newer_activity
         OR (p_expected_active_comment_count IS NOT NULL AND v_actual_active_comment_count > p_expected_active_comment_count) THEN
        RAISE EXCEPTION 'New comments or regrade requests were added to a rubric check being deleted while you were reviewing. Review the updated list and confirm again.'
          USING ERRCODE = 'foreign_key_violation', HINT = 'rubric_checks_in_use';
      END IF;

      -- Snapshot ground-truth report before soft-deleting comments and detaching checks.
      v_deleted_checks_report := jsonb_build_object(
        'deleted_at', now(),
        'rubric_id', v_rubric_id,
        'rubric_name', v_new_name,
        'checks', public._collect_rubric_check_usage(v_rubric_id, v_class_id, v_in_use_check_ids)
      );

      -- Soft-delete confirmed active comments across all three comment tables and detach rubric_check_id.
      UPDATE public.submission_comments
      SET deleted_at = now(),
          edited_at = now(),
          edited_by = COALESCE(v_actor_profile_id, edited_by),
          rubric_check_id = NULL
      WHERE rubric_check_id = ANY(v_in_use_check_ids)
        AND deleted_at IS NULL;
      GET DIAGNOSTICS v_tmp_count = ROW_COUNT;
      v_comments_deleted := v_comments_deleted + v_tmp_count;

      UPDATE public.submission_file_comments
      SET deleted_at = now(),
          edited_at = now(),
          edited_by = COALESCE(v_actor_profile_id, edited_by),
          rubric_check_id = NULL
      WHERE rubric_check_id = ANY(v_in_use_check_ids)
        AND deleted_at IS NULL;
      GET DIAGNOSTICS v_tmp_count = ROW_COUNT;
      v_comments_deleted := v_comments_deleted + v_tmp_count;

      UPDATE public.submission_artifact_comments
      SET deleted_at = now(),
          edited_at = now(),
          edited_by = COALESCE(v_actor_profile_id, edited_by),
          rubric_check_id = NULL
      WHERE rubric_check_id = ANY(v_in_use_check_ids)
        AND deleted_at IS NULL;
      GET DIAGNOSTICS v_tmp_count = ROW_COUNT;
      v_comments_deleted := v_comments_deleted + v_tmp_count;
    END IF;

    -- Detach rubric_check_id from already-soft-deleted comments so checks with only
    -- previously-deleted comments can be removed cleanly without FK errors.
    UPDATE public.submission_comments
    SET rubric_check_id = NULL
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND deleted_at IS NOT NULL;

    UPDATE public.submission_file_comments
    SET rubric_check_id = NULL
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND deleted_at IS NOT NULL;

    UPDATE public.submission_artifact_comments
    SET rubric_check_id = NULL
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND deleted_at IS NOT NULL;

    -- Detach comment-backed regrade requests from deleted checks (their comment FK remains intact).
    -- Any still-open/draft request (or one just auto-resolved by auto_resolve_regrade_on_comment_delete
    -- during the soft-delete above) gets resolution_reason = 'rubric_check_deleted'.
    UPDATE public.submission_regrade_requests
    SET rubric_check_id = NULL,
        status = CASE
          WHEN status IN ('draft', 'opened') THEN 'resolved'::regrade_status
          ELSE status
        END,
        resolved_by = CASE
          WHEN status IN ('draft', 'opened') THEN COALESCE(v_actor_profile_id, assignee)
          ELSE resolved_by
        END,
        resolved_at = CASE
          WHEN status IN ('draft', 'opened') THEN now()
          ELSE resolved_at
        END,
        resolved_points = CASE
          WHEN status IN ('draft', 'opened') THEN COALESCE(resolved_points, initial_points)
          ELSE resolved_points
        END,
        resolution_reason = CASE
          WHEN status IN ('draft', 'opened')
               OR (status = 'resolved' AND resolution_reason = 'comment_deleted' AND resolved_at >= now() - interval '5 seconds')
            THEN 'rubric_check_deleted'
          ELSE resolution_reason
        END,
        last_updated_at = now()
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND (
        submission_comment_id IS NOT NULL
        OR submission_file_comment_id IS NOT NULL
        OR submission_artifact_comment_id IS NOT NULL
      );

    -- Detach and resolve bare-check regrade requests targeting deleted checks.
    UPDATE public.submission_regrade_requests
    SET rubric_check_id = NULL,
        status = 'resolved',
        resolved_by = COALESCE(v_actor_profile_id, assignee),
        resolved_at = now(),
        resolution_reason = 'rubric_check_deleted',
        last_updated_at = now()
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND submission_comment_id IS NULL
      AND submission_file_comment_id IS NULL
      AND submission_artifact_comment_id IS NULL
      AND status IN ('draft', 'opened');

    UPDATE public.submission_regrade_requests
    SET rubric_check_id = NULL,
        resolution_reason = 'rubric_check_deleted',
        last_updated_at = now()
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND submission_comment_id IS NULL
      AND submission_file_comment_id IS NULL
      AND submission_artifact_comment_id IS NULL
      AND status = 'escalated';

    UPDATE public.submission_regrade_requests
    SET rubric_check_id = NULL
    WHERE rubric_check_id = ANY(v_removed_check_ids)
      AND submission_comment_id IS NULL
      AND submission_file_comment_id IS NULL
      AND submission_artifact_comment_id IS NULL
      AND status IN ('resolved', 'closed');

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

  ----------------------------------------------------------------
  -- Phase 5: recompute affected submission reviews.
  ----------------------------------------------------------------
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

  IF v_comments_deleted > 0 THEN
    v_summary := v_summary || ' Deleted ' || v_comments_deleted || ' applied comment'
              || CASE WHEN v_comments_deleted = 1 THEN '' ELSE 's' END || '.';
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

  RETURN jsonb_build_object(
    'summary', v_summary,
    'deleted_checks_report', v_deleted_checks_report
  );
END;
$function$;

COMMENT ON FUNCTION public.update_rubric_full_with_report(jsonb, bigint[], timestamptz, int) IS
  'Atomically creates or updates a rubric (parts, criteria, checks, references), optionally soft-deleting and detaching comments on confirmed in-use rubric checks, recomputes affected submission_reviews, and returns { summary, deleted_checks_report }. Requires manage_rubrics.';

REVOKE ALL ON FUNCTION public.update_rubric_full_with_report(jsonb, bigint[], timestamptz, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_rubric_full_with_report(jsonb, bigint[], timestamptz, int) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Backwards-compatible wrapper for update_rubric_full(p_rubric jsonb)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_rubric_full(p_rubric jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '3min'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.update_rubric_full_with_report(p_rubric, ARRAY[]::bigint[], NULL, NULL);
  RETURN v_result->>'summary';
END;
$function$;

COMMENT ON FUNCTION public.update_rubric_full(jsonb) IS
  'Backwards-compatible wrapper around update_rubric_full_with_report returning only the summary text and refusing to delete checks with active applied comments.';

REVOKE ALL ON FUNCTION public.update_rubric_full(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_rubric_full(jsonb) TO authenticated, service_role;
