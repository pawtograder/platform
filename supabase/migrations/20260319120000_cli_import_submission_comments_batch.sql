-- CLI batch import/sync for submission comments (file, artifact, submission-level).
-- One atomic transaction per RPC call. Invoke from edge function using service_role only.

CREATE OR REPLACE FUNCTION public._cli_resolve_submission_file_id(
  p_submission_id bigint,
  p_file_name text
) RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_id bigint;
  v_base text;
BEGIN
  IF p_file_name IS NULL OR p_file_name = '' THEN
    RETURN NULL;
  END IF;

  v_base := split_part(p_file_name, '/', -1);

  SELECT sf.id INTO v_id
  FROM submission_files sf
  WHERE sf.submission_id = p_submission_id
    AND sf.name = p_file_name
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT sf.id INTO v_id
  FROM submission_files sf
  WHERE sf.submission_id = p_submission_id
    AND sf.name = v_base
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT sf.id INTO v_id
  FROM submission_files sf
  WHERE sf.submission_id = p_submission_id
    AND (
      sf.name LIKE '%' || p_file_name
      OR p_file_name LIKE '%' || sf.name
      OR sf.name LIKE '%' || v_base
      OR v_base LIKE '%' || sf.name
    )
  ORDER BY length(sf.name)
  LIMIT 1;

  RETURN v_id;
END;
$$;

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
    points int,
    author uuid,
    submission_file_id bigint,
    grading_review_id bigint,
    class_id bigint,
    eff_points int,
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
    NULLIF(value->>'points', '')::integer,
    COALESCE(
      NULLIF(value->>'author', '')::uuid,
      NULLIF(p_authors_by_submission->>(value->>'submission_id'), '')::uuid,
      p_default_author
    ),
    NULL::bigint,
    s.grading_review_id,
    s.class_id,
    NULL::int,
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
    );

  UPDATE _cli_fc fc
  SET should_insert = (
    fc.err IS NULL
    AND fc.submission_file_id IS NOT NULL
    AND NOT (
      fc.rubric_check_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM submission_file_comments sfc
        WHERE sfc.submission_id = fc.submission_id
          AND sfc.rubric_check_id = fc.rubric_check_id
          AND sfc.deleted_at IS NULL
      )
    )
  );

  SELECT count(*) FILTER (WHERE should_insert) INTO v_file_ins FROM _cli_fc;
  SELECT count(*) FILTER (
    WHERE err IS NULL AND submission_file_id IS NOT NULL AND NOT should_insert AND rubric_check_id IS NOT NULL
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
    points int,
    author uuid,
    submission_artifact_id bigint,
    grading_review_id bigint,
    class_id bigint,
    eff_points int,
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
    NULLIF(value->>'points', '')::integer,
    COALESCE(
      NULLIF(value->>'author', '')::uuid,
      NULLIF(p_authors_by_submission->>(value->>'submission_id'), '')::uuid,
      p_default_author
    ),
    NULL::bigint,
    s.grading_review_id,
    s.class_id,
    NULL::int,
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
    );

  UPDATE _cli_ac ac
  SET should_insert = (
    ac.err IS NULL
    AND ac.submission_artifact_id IS NOT NULL
    AND NOT (
      ac.rubric_check_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM submission_artifact_comments sac
        WHERE sac.submission_id = ac.submission_id
          AND sac.rubric_check_id = ac.rubric_check_id
          AND sac.submission_artifact_id = ac.submission_artifact_id
          AND sac.deleted_at IS NULL
      )
    )
  );

  SELECT count(*) FILTER (WHERE should_insert) INTO v_art_ins FROM _cli_ac;
  SELECT count(*) FILTER (
    WHERE err IS NULL AND submission_artifact_id IS NOT NULL AND NOT should_insert AND rubric_check_id IS NOT NULL
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
    points int,
    author uuid,
    grading_review_id bigint,
    class_id bigint,
    eff_points int,
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
    NULLIF(value->>'points', '')::integer,
    COALESCE(
      NULLIF(value->>'author', '')::uuid,
      NULLIF(p_authors_by_submission->>(value->>'submission_id'), '')::uuid,
      p_default_author
    ),
    s.grading_review_id,
    s.class_id,
    NULL::int,
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
    );

  UPDATE _cli_sc sc
  SET should_insert = (
    sc.err IS NULL
    AND NOT (
      sc.rubric_check_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM submission_comments c
        WHERE c.submission_id = sc.submission_id
          AND c.rubric_check_id = sc.rubric_check_id
          AND c.deleted_at IS NULL
      )
    )
  );

  SELECT count(*) FILTER (WHERE should_insert) INTO v_sub_ins FROM _cli_sc;
  SELECT count(*) FILTER (
    WHERE err IS NULL AND NOT should_insert AND rubric_check_id IS NOT NULL
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

REVOKE ALL ON FUNCTION public._cli_resolve_submission_file_id(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cli_import_submission_comments_batch(
  bigint, bigint, text, boolean, jsonb, jsonb, jsonb, bigint[], uuid, jsonb, boolean, boolean
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public._cli_resolve_submission_file_id(bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cli_import_submission_comments_batch(
  bigint, bigint, text, boolean, jsonb, jsonb, jsonb, bigint[], uuid, jsonb, boolean, boolean
) TO service_role;

COMMENT ON FUNCTION public.cli_import_submission_comments_batch(
  bigint, bigint, text, boolean, jsonb, jsonb, jsonb, bigint[], uuid, jsonb, boolean, boolean
) IS 'Batch import/sync submission comments for CLI edge function; service_role only.';
