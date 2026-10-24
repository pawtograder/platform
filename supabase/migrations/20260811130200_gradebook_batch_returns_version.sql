-- Two defects in the gradebook version-mismatch recovery path.
--
-- 1. The caller cannot scope its recovery to a version.
--
--    update_gradebook_rows_batch() reports `version_matched: false` for a row whose
--    gradebook_row_recalc_state.version moved while the worker was computing, but it reports only
--    the boolean. The edge function then clears `is_recalculating` filtering on
--    (class_id, gradebook_id, student_id, is_private) alone -- the version it acted on is not part
--    of the predicate, and `expected_version` cannot be: on a mismatch that value is by definition
--    NOT the row's version. So the clear is a blind write by primary key, and it releases whatever
--    claim the row holds at that instant, including one a *different* worker took in the window
--    between this RPC returning and the clear landing. Two workers then recalculate the same row
--    with neither holding the claim.
--
--    Fix: every result element now carries `current_version` -- the row's live version, read in a
--    separate statement after the main one so it reflects the effects of the main statement's own
--    triggers -- plus the `expected_version` the caller passed in, for diagnosis. The caller adds
--    `version = current_version` to its clear, which no-ops harmlessly if the row was re-claimed.
--
-- 2. Nothing bounds the re-enqueue.
--
--    This function archives every message id it is handed, unconditionally, so the caller's
--    recovery re-enqueue is a brand-new pgmq message with read_ct back at 0. pgmq's own read
--    counter therefore cannot bound the loop, and there was no other ceiling, no backoff, and no
--    escape hatch. Under sustained contention -- a submission deadline, which is exactly when
--    version mismatches happen -- every mismatched row of every 75-row chunk was re-enqueued on
--    every pass, and gradebook_row_recalculate could sustain itself instead of draining.
--
--    Fix (caller side): an explicit attempt counter in the message payload, exponential backoff via
--    send_batch's sleep_seconds, and a ceiling past which the row goes to the DLQ created below.
--
-- The return TYPE is unchanged (jsonb), so CREATE OR REPLACE is sufficient; only keys inside the
-- returned document are added. Signature, volatility, SECURITY DEFINER posture, search_path,
-- statement_timeout and grants are all preserved verbatim.

-- ---------------------------------------------------------------------------
-- Dead letter queue for rows that exhaust the version-mismatch retry ceiling.
--
-- Same shape as async_calls_dlq (20251113141300) and discord_async_calls_dlq (20260207011716):
-- a sibling pgmq queue the worker sends to, so a row that gives up is a durable, inspectable
-- message rather than a dropped one. Inspect with:
--   SELECT msg_id, enqueued_at, message FROM pgmq.q_gradebook_row_recalculate_dlq ORDER BY msg_id;
-- ---------------------------------------------------------------------------

do $$
begin
  perform pgmq.create('gradebook_row_recalculate_dlq');
exception when others then
  -- queue likely exists; ignore
  null;
end $$;

grant insert on table pgmq.q_gradebook_row_recalculate_dlq to service_role;
grant select on table pgmq.q_gradebook_row_recalculate_dlq to service_role;
grant delete on table pgmq.q_gradebook_row_recalculate_dlq to service_role;
grant update on table pgmq.q_gradebook_row_recalculate_dlq to service_role;

grant insert on table pgmq.a_gradebook_row_recalculate_dlq to service_role;
grant select on table pgmq.a_gradebook_row_recalculate_dlq to service_role;
grant delete on table pgmq.a_gradebook_row_recalculate_dlq to service_role;
grant update on table pgmq.a_gradebook_row_recalculate_dlq to service_role;

-- ---------------------------------------------------------------------------
-- update_gradebook_rows_batch: return the version each result was decided against.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_gradebook_rows_batch(p_batch_updates jsonb[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
SET statement_timeout TO '3min'
AS $$
DECLARE
  results jsonb;
  rows_to_reenqueue jsonb;
  messages_to_send jsonb[];
  message_ids_to_archive bigint[];
  msg_id bigint;
  expanded_count integer;
  version_matched_count integer;
  updated_gcs_count integer;
  unique_students_count integer;
  cleared_state_count integer;
  cleared_details jsonb;
BEGIN
  WITH student_updates_expanded AS (
    SELECT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      jsonb_array_elements(su->'updates') AS update_obj
    FROM unnest(p_batch_updates) AS su
    WHERE su->'updates' IS NOT NULL
      AND jsonb_typeof(su->'updates') = 'array'
      AND jsonb_array_length(su->'updates') > 0
  ),
  -- Version check gates updates to prevent stale data from overwriting fresh data
  -- when multiple workers process the same student concurrently.
  updates_with_context AS (
    SELECT
      sue.*,
      (update_obj->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (update_obj->>'score')::numeric AS score,
      (update_obj->>'is_missing')::boolean AS is_missing,
      (update_obj->>'released')::boolean AS released,
      update_obj->'incomplete_values' AS incomplete_values
    FROM student_updates_expanded sue
    WHERE EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = sue.class_id
        AND rs.gradebook_id = sue.gradebook_id
        AND rs.student_id = sue.student_id
        AND rs.is_private = sue.is_private
        AND rs.version = sue.expected_version
    )
  ),
  -- Only touch rows where at least one value actually differs
  updated_rows AS (
    UPDATE public.gradebook_column_students gcs
    SET
      score = uwc.score,
      is_missing = uwc.is_missing,
      released = uwc.released,
      incomplete_values = uwc.incomplete_values
    FROM updates_with_context uwc
    WHERE gcs.gradebook_column_id = uwc.gradebook_column_id
      AND gcs.student_id = uwc.student_id
      AND gcs.class_id = uwc.class_id
      AND gcs.gradebook_id = uwc.gradebook_id
      AND gcs.is_private = uwc.is_private
      AND (
        gcs.score IS DISTINCT FROM uwc.score
        OR gcs.is_missing IS DISTINCT FROM uwc.is_missing
        OR gcs.released IS DISTINCT FROM uwc.released
        OR gcs.incomplete_values IS DISTINCT FROM uwc.incomplete_values
      )
    RETURNING gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private, uwc.expected_version
  ),
  update_counts AS (
    SELECT class_id, gradebook_id, student_id, is_private, expected_version, COUNT(*) AS updated_count
    FROM updated_rows GROUP BY class_id, gradebook_id, student_id, is_private, expected_version
  ),
  students_with_no_updates AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id, (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id, (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE (su->'updates' IS NULL OR jsonb_typeof(su->'updates') != 'array' OR jsonb_array_length(su->'updates') = 0)
    AND EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  -- Clear recalc state for students where version matched (updates applied
  -- or no updates needed). For version mismatches the state stays dirty so
  -- the re-enqueue below can proceed.
  all_students_to_clear AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id, (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id, (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  cleared_rows AS (
    UPDATE public.gradebook_row_recalc_state rs
    SET dirty = false, is_recalculating = false, updated_at = NOW()
    FROM (SELECT * FROM all_students_to_clear ORDER BY class_id, gradebook_id, student_id, is_private) astc
    WHERE rs.class_id = astc.class_id
      AND rs.gradebook_id = astc.gradebook_id
      AND rs.student_id = astc.student_id
      AND rs.is_private = astc.is_private
      AND rs.version = astc.expected_version
    RETURNING rs.class_id, rs.gradebook_id, rs.student_id, rs.is_private, rs.dirty, rs.is_recalculating, rs.version
  ),
  student_results AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id, (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id, (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      COALESCE((SELECT jsonb_agg(elem::text::bigint) FROM jsonb_array_elements_text(su->'message_ids') AS elem), '[]'::jsonb) AS message_ids,
      COALESCE(uc.updated_count, 0) AS updated_count,
      EXISTS (SELECT 1 FROM public.gradebook_row_recalc_state rs WHERE rs.class_id = (su->>'class_id')::bigint AND rs.gradebook_id = (su->>'gradebook_id')::bigint AND rs.student_id = (su->>'student_id')::uuid AND rs.is_private = (su->>'is_private')::boolean AND rs.version = (su->>'expected_version')::bigint) AS version_matched,
      EXISTS (SELECT 1 FROM cleared_rows cr WHERE cr.class_id = (su->>'class_id')::bigint AND cr.gradebook_id = (su->>'gradebook_id')::bigint AND cr.student_id = (su->>'student_id')::uuid AND cr.is_private = (su->>'is_private')::boolean) AS cleared
    FROM unnest(p_batch_updates) AS su
    LEFT JOIN update_counts uc ON uc.class_id = (su->>'class_id')::bigint AND uc.gradebook_id = (su->>'gradebook_id')::bigint AND uc.student_id = (su->>'student_id')::uuid AND uc.is_private = (su->>'is_private')::boolean
  ),
  debug_counts AS (
    SELECT
      (SELECT COUNT(*) FROM student_updates_expanded) AS expanded_count_val,
      (SELECT COUNT(*) FROM updates_with_context) AS version_matched_count_val,
      (SELECT COUNT(*) FROM updated_rows) AS updated_gcs_count_val,
      (SELECT COUNT(DISTINCT (class_id, gradebook_id, student_id, is_private)) FROM update_counts) AS unique_students_count_val,
      (SELECT COUNT(*) FROM cleared_rows) AS cleared_state_count_val
  ),
  final_results AS (
    SELECT
      -- expected_version is now echoed back: on a mismatch it is the only way the caller can tell
      -- WHICH version it lost to when compared against current_version below, and the pair is what
      -- makes a "clearing a claim we no longer hold" bug visible in a log line.
      jsonb_agg(jsonb_build_object('class_id', class_id, 'gradebook_id', gradebook_id, 'student_id', student_id, 'is_private', is_private, 'message_ids', message_ids, 'updated_count', updated_count, 'version_matched', version_matched, 'cleared', cleared, 'expected_version', expected_version) ORDER BY student_id) AS results_jsonb,
      (SELECT expanded_count_val FROM debug_counts LIMIT 1) AS ecv,
      (SELECT version_matched_count_val FROM debug_counts LIMIT 1) AS vmcv,
      (SELECT updated_gcs_count_val FROM debug_counts LIMIT 1) AS ugcv,
      (SELECT unique_students_count_val FROM debug_counts LIMIT 1) AS uscv,
      (SELECT cleared_state_count_val FROM debug_counts LIMIT 1) AS cscv
    FROM student_results
  )
  SELECT results_jsonb, ecv, vmcv, ugcv, uscv, cscv
  INTO results, expanded_count, version_matched_count, updated_gcs_count, unique_students_count, cleared_state_count
  FROM final_results;

  -- Attach each row's LIVE version to its result.
  --
  -- Deliberately a SEPARATE statement from the CTE above. Inside that statement every CTE reads one
  -- snapshot taken at statement start, so it cannot see the version bumps its own
  -- gradebook_column_students UPDATE triggered. A new statement in the same transaction takes a new
  -- command snapshot and does see them, which is what makes current_version a value the caller can
  -- actually match a WHERE clause against a moment later.
  --
  -- NULL current_version means no gradebook_row_recalc_state row exists, so there is no claim to
  -- release; the caller must skip the clear rather than guess a version.
  IF results IS NOT NULL THEN
    SELECT jsonb_agg(r.obj || jsonb_build_object('current_version', rs.version) ORDER BY r.obj->>'student_id')
    INTO results
    FROM jsonb_array_elements(results) AS r(obj)
    LEFT JOIN public.gradebook_row_recalc_state rs
      ON rs.class_id = (r.obj->>'class_id')::bigint
      AND rs.gradebook_id = (r.obj->>'gradebook_id')::bigint
      AND rs.student_id = (r.obj->>'student_id')::uuid
      AND rs.is_private = (r.obj->>'is_private')::boolean;
  END IF;

  -- Archive all messages
  SELECT ARRAY_AGG(DISTINCT msg_ids.msg_id) INTO message_ids_to_archive
  FROM (
    SELECT UNNEST(
      ARRAY(
        SELECT jsonb_array_elements_text(su->'message_ids')
        FROM unnest(p_batch_updates) AS su
        WHERE su->'message_ids' IS NOT NULL
      )
    )::bigint AS msg_id
  ) AS msg_ids;

  IF message_ids_to_archive IS NOT NULL AND array_length(message_ids_to_archive, 1) > 0 THEN
    FOREACH msg_id IN ARRAY message_ids_to_archive LOOP
      PERFORM pgmq_public.archive('gradebook_row_recalculate', msg_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('results', results, 'expanded_count', expanded_count, 'version_matched_count', version_matched_count, 'updated_gcs_count', updated_gcs_count, 'unique_students_count', unique_students_count, 'cleared_state_count', cleared_state_count);
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_rows_batch(jsonb[]) IS 'Batch updates gradebook rows and clears recalculation state. Each result element reports expected_version (what the caller acted on) and current_version (the row''s live version after this call''s own triggers, NULL if no state row), so the caller can scope its is_recalculating recovery to exactly the version it observed instead of clearing by primary key and stomping another worker''s claim.';

-- Re-apply the original grant posture verbatim.
REVOKE ALL ON FUNCTION "public"."update_gradebook_rows_batch"("p_batch_updates" "jsonb"[]) FROM "anon";
REVOKE ALL ON FUNCTION "public"."update_gradebook_rows_batch"("p_batch_updates" "jsonb"[]) FROM "authenticated";
GRANT ALL ON FUNCTION "public"."update_gradebook_rows_batch"("p_batch_updates" "jsonb"[]) TO "service_role";
