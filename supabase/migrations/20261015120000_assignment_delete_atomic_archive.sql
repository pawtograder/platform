-- Make assignment deletion fast, atomic with its GitHub cleanup, and not callable by API roles.
--
-- Incident 2026-10-15 (CS 3650 fa26, assignment 1259, 238 repositories): assignment-delete
-- queued 239 archive_repo_and_lock jobs, THEN called delete_assignment_with_all_data, which
-- hit authenticator's 8s statement_timeout and rolled back. The archive jobs only need
-- org/repo, so they kept archiving, renaming and stripping collaborators from the repos of
-- an assignment that was still live. A "sync to handout" an hour later queued 238
-- sync_repo_to_handout jobs against those same repos. Completing the delete by hand took
-- 81s for an assignment with 0 submissions.
--
-- ---------------------------------------------------------------------------
-- 1. WHY IT TOOK 81 SECONDS: unindexed foreign keys
-- ---------------------------------------------------------------------------
-- Deleting a referenced row makes Postgres check every FK that points at it, one query per
-- deleted row. With no index on the referencing column each check is a sequential scan:
--
--   workflow_events.repository_id          -> repositories           1.19M rows, 471 MB
--   submissions.repository_check_run_id    -> repository_check_runs  407k rows,  137 MB
--   repository_check_runs.target_submission_id -> submissions        480k rows,  225 MB
--   submission_files.assignment_group_id   -> assignment_groups      5.5M rows, 5.5 GB
--   submission_file_symbol_index.assignment_group_id -> assignment_groups  2.1M rows, 1.3 GB
--   grader_result_output.assignment_group_id -> assignment_groups    657k rows,  420 MB
--
-- 238 repositories x one scan of workflow_events each is the 81s. A group assignment would
-- be far worse: one 5.5 GB scan of submission_files per assignment_group.
--
-- The four mostly-NULL columns (73-99% NULL in production) get partial indexes. An FK check
-- is `WHERE col = $1`, which implies `col IS NOT NULL`, so the planner can use them.
--
-- PLAIN CREATE INDEX, not CONCURRENTLY: migrate.sh applies each migration under
-- `psql --single-transaction`, where CONCURRENTLY errors and fails the deploy (see
-- 20260904120000_metrics_gap_remediation.sql). A plain build blocks writes to the table while
-- it runs; submission_files is on the submission path. Build them by hand first and the
-- statements below become no-ops:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_events_repository_id
--     ON public.workflow_events (repository_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_submissions_repository_check_run_id
--     ON public.submissions (repository_check_run_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_repository_check_runs_target_submission_id
--     ON public.repository_check_runs (target_submission_id) WHERE target_submission_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_submission_files_assignment_group_id
--     ON public.submission_files (assignment_group_id) WHERE assignment_group_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_submission_file_symbol_index_assignment_group_id
--     ON public.submission_file_symbol_index (assignment_group_id) WHERE assignment_group_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grader_result_output_assignment_group_id
--     ON public.grader_result_output (assignment_group_id) WHERE assignment_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_events_repository_id
  ON public.workflow_events (repository_id);
CREATE INDEX IF NOT EXISTS idx_submissions_repository_check_run_id
  ON public.submissions (repository_check_run_id);
CREATE INDEX IF NOT EXISTS idx_repository_check_runs_target_submission_id
  ON public.repository_check_runs (target_submission_id) WHERE target_submission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submission_files_assignment_group_id
  ON public.submission_files (assignment_group_id) WHERE assignment_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submission_file_symbol_index_assignment_group_id
  ON public.submission_file_symbol_index (assignment_group_id) WHERE assignment_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grader_result_output_assignment_group_id
  ON public.grader_result_output (assignment_group_id) WHERE assignment_group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. GitHub cleanup commits with the delete, not before it
-- ---------------------------------------------------------------------------
-- p_enqueue_github_archives = true makes the function queue the archive jobs itself, inside
-- its own transaction, so a delete that fails or times out queues nothing. The targets are
-- the repository rows this call actually deletes (DELETE ... RETURNING), plus the template
-- and grader repos read under the same lock, so a repository created between the edge
-- function's safety checks and this call is archived instead of orphaned on GitHub.
--
-- It also cancels queued sync_repo_to_handout jobs for the deleted repositories. Those jobs
-- name a repository row that no longer exists, and the handout they sync is being archived.
-- If one is already claimed by a worker it cannot be cancelled, so the delete refuses with a
-- retryable error rather than archive a repository a sync is still writing to.
--
-- The result now carries `github_repositories` ({kind, full_name}, validated owner/repo, in
-- the order the edge function's debug ids assume) so the synchronous-delete path can delete
-- exactly what was removed from the database.
--
-- The old (bigint, bigint) signature is dropped rather than overloaded. Called with two
-- named arguments, PostgREST resolves to this function with the default, so edge functions
-- built before this migration keep working during a rollout (they queue their own archives
-- first, exactly as before).

DROP FUNCTION IF EXISTS public.delete_assignment_with_all_data(bigint, bigint);

CREATE FUNCTION public.delete_assignment_with_all_data(
    p_assignment_id bigint,
    p_class_id bigint,
    p_enqueue_github_archives boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_assignment_title text;
    v_template_repo text;
    v_grader_repo text;
    v_assignment_group_ids bigint[];
    v_gradebook_column_id bigint;
    v_repository_ids bigint[];
    v_repository_names text[];
    v_github_repositories jsonb := '[]'::jsonb;
    v_target record;
    v_index integer := 0;
    v_archives_queued integer := 0;
    v_sync_msg_ids bigint[];
    v_syncs_in_flight integer := 0;
    v_syncs_cancelled integer := 0;
BEGIN
    -- Only service_role and postgres may call this (see the REVOKE below); authorization of
    -- the human behind the request is the calling edge function's job.

    -- Check if assignment exists and belongs to the specified class
    SELECT title, template_repo INTO v_assignment_title, v_template_repo
    FROM public.assignments
    WHERE id = p_assignment_id AND class_id = p_class_id FOR UPDATE; -- Lock the assignment row

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment not found or does not belong to this class'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Check for released submission reviews (safety check)
    IF EXISTS (
        SELECT 1 FROM public.submission_reviews sr
        JOIN public.submissions s ON sr.submission_id = s.id
        WHERE s.assignment_id = p_assignment_id AND sr.released = true
    ) THEN
        RAISE EXCEPTION 'Cannot delete assignment: This assignment has released submission reviews. Delete cannot proceed.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Read before the autograder row is deleted below.
    SELECT grader_repo INTO v_grader_repo FROM public.autograder WHERE id = p_assignment_id;

    -- Handout syncs for this assignment's repositories. A queued one would write a sync branch
    -- into a repository that is about to be archived, so it is cancelled. A CLAIMED one (read
    -- by a worker: read_ct > 0 and still invisible) cannot be stopped from here -- deleting its
    -- queue row does not stop the worker holding the envelope, which may already be past its
    -- row check and mutating GitHub -- so the delete waits for it instead of racing it.
    --
    -- FOR UPDATE is what makes the check hold for the rest of this transaction: pgmq.read
    -- claims with FOR UPDATE SKIP LOCKED, so no worker can claim these rows between the check
    -- and the delete. (read_ct = 0 with a future vt is a delayed requeue, not a claim.)
    SELECT array_agg(id) INTO v_repository_ids
      FROM public.repositories WHERE assignment_id = p_assignment_id;

    IF v_repository_ids IS NOT NULL THEN
        SELECT array_agg(q.msg_id),
               count(*) FILTER (WHERE q.read_ct > 0 AND q.vt > clock_timestamp())
          INTO v_sync_msg_ids, v_syncs_in_flight
          FROM (
            SELECT msg_id, read_ct, vt FROM pgmq.q_async_calls
             WHERE message->>'method' = 'sync_repo_to_handout'
               AND message->'args'->>'repository_id' = ANY (v_repository_ids::text[])
             FOR UPDATE
          ) q;

        IF v_syncs_in_flight > 0 THEN
            RAISE EXCEPTION 'Cannot delete assignment: % handout sync(s) for its repositories are running right now. Try again in a few minutes.',
                v_syncs_in_flight
                USING ERRCODE = 'object_in_use';
        END IF;

        IF v_sync_msg_ids IS NOT NULL THEN
            SELECT count(*) INTO v_syncs_cancelled FROM pgmq.delete('async_calls', v_sync_msg_ids);
        END IF;
    END IF;

    -- Get assignment group IDs for this assignment
    SELECT array_agg(id) INTO v_assignment_group_ids
    FROM public.assignment_groups
    WHERE assignment_id = p_assignment_id;

    -- Get the gradebook column ID for this assignment
    SELECT gradebook_column_id INTO v_gradebook_column_id
    FROM public.assignments
    WHERE id = p_assignment_id;

    -- Start transaction
    BEGIN
        -- Remove gradebook column dependencies first (if this assignment has a gradebook column)
        IF v_gradebook_column_id IS NOT NULL THEN
            UPDATE public.gradebook_columns
            SET dependencies = jsonb_set(
                COALESCE(dependencies, '{}'::jsonb),
                '{gradebook_columns}',
                to_jsonb(
                    array_remove(
                        ARRAY(SELECT jsonb_array_elements_text(COALESCE(dependencies->'gradebook_columns', '[]'::jsonb)))::bigint[],
                        v_gradebook_column_id
                    )
                )
            )
            WHERE class_id = p_class_id
              AND id != v_gradebook_column_id
              AND dependencies IS NOT NULL
              AND dependencies->'gradebook_columns' IS NOT NULL
              AND dependencies->'gradebook_columns' @> to_jsonb(ARRAY[v_gradebook_column_id]::bigint[]);
        END IF;

        -- Delete in order to respect foreign key constraints

        -- Delete submission regrade request comments
        DELETE FROM public.submission_regrade_request_comments srrc
        USING public.submission_regrade_requests srr
        WHERE srrc.submission_regrade_request_id = srr.id AND srr.assignment_id = p_assignment_id;

        -- Handle circular FK constraints: clear regrade_request_id references first
        UPDATE public.submission_comments
        SET regrade_request_id = NULL
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );

        UPDATE public.submission_file_comments
        SET regrade_request_id = NULL
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );

        UPDATE public.submission_artifact_comments
        SET regrade_request_id = NULL
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );

        -- Delete submission regrade requests (now safe after clearing circular FK)
        DELETE FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id;

        -- Delete submission artifact comments first (before submission artifacts)
        DELETE FROM public.submission_artifact_comments sac
        USING public.submission_artifacts sa
        JOIN public.submissions s ON sa.submission_id = s.id
        WHERE sac.submission_artifact_id = sa.id AND s.assignment_id = p_assignment_id;

        -- Delete submission artifacts (before submission files due to FK constraint)
        DELETE FROM public.submission_artifacts sa
        USING public.submissions s
        WHERE sa.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Delete submission file comments
        DELETE FROM public.submission_file_comments sfc
        USING public.submission_files sf
        JOIN public.submissions s ON sf.submission_id = s.id
        WHERE sfc.submission_file_id = sf.id AND s.assignment_id = p_assignment_id;

        -- Delete submission files
        DELETE FROM public.submission_files sf
        USING public.submissions s
        WHERE sf.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Delete submission comments (only those that don't reference regrade requests)
        DELETE FROM public.submission_comments sc
        USING public.submissions s
        WHERE sc.submission_id = s.id AND s.assignment_id = p_assignment_id
          AND sc.regrade_request_id IS NULL;

        -- Delete grader result test output first (before grader result tests)
        DELETE FROM public.grader_result_test_output grto
        USING public.grader_result_tests grt
        JOIN public.grader_results gr ON grt.grader_result_id = gr.id
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grto.grader_result_test_id = grt.id AND s.assignment_id = p_assignment_id;

        -- Delete grader result tests (before grader results)
        DELETE FROM public.grader_result_tests grt
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grt.grader_result_id = gr.id AND s.assignment_id = p_assignment_id;

        -- Delete grader result output (before grader results)
        DELETE FROM public.grader_result_output gro
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE gro.grader_result_id = gr.id AND s.assignment_id = p_assignment_id;

        -- Delete grader results
        DELETE FROM public.grader_results gr
        USING public.submissions s
        WHERE gr.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Clear grading_review_id references before deleting submission reviews
        UPDATE public.submissions
        SET grading_review_id = NULL
        WHERE assignment_id = p_assignment_id AND grading_review_id IS NOT NULL;

        -- Delete review assignments (before submission reviews due to FK constraint)
        DELETE FROM public.review_assignments WHERE assignment_id = p_assignment_id;

        -- Delete submission reviews
        DELETE FROM public.submission_reviews sr
        USING public.submissions s
        WHERE sr.submission_id = s.id AND s.assignment_id = p_assignment_id;

        -- Delete submissions
        DELETE FROM public.submissions WHERE assignment_id = p_assignment_id;

        -- Delete repository check runs (before repositories due to FK constraint)
        DELETE FROM public.repository_check_runs rcr
        USING public.repositories r
        WHERE rcr.repository_id = r.id AND r.assignment_id = p_assignment_id;

        -- Delete workflow events that reference repositories for this assignment
        DELETE FROM public.workflow_events we
        USING public.repositories r
        WHERE we.repository_id = r.id AND r.assignment_id = p_assignment_id;

        -- Delete workflow run errors that reference repositories for this assignment
        DELETE FROM public.workflow_run_error wre
        USING public.repositories r
        WHERE wre.repository_id = r.id AND r.assignment_id = p_assignment_id;

        -- Delete repositories, keeping exactly what was removed: these are the GitHub targets.
        WITH deleted AS (
            DELETE FROM public.repositories WHERE assignment_id = p_assignment_id
            RETURNING id, repository
        )
        SELECT array_agg(id ORDER BY id), array_agg(repository ORDER BY id)
          INTO v_repository_ids, v_repository_names
          FROM deleted;

        -- Delete assignment group members
        DELETE FROM public.assignment_groups_members WHERE assignment_id = p_assignment_id;

        -- Delete assignment group invitations for this assignment's groups
        IF v_assignment_group_ids IS NOT NULL AND array_length(v_assignment_group_ids, 1) > 0 THEN
            DELETE FROM public.assignment_group_invitations
            WHERE assignment_group_id = ANY(v_assignment_group_ids);
        END IF;

        -- Delete assignment group join requests
        DELETE FROM public.assignment_group_join_request WHERE assignment_id = p_assignment_id;

        -- Delete assignment groups
        DELETE FROM public.assignment_groups WHERE assignment_id = p_assignment_id;

        -- Delete due date exceptions
        DELETE FROM public.assignment_due_date_exceptions WHERE assignment_id = p_assignment_id;

        -- Clear rubric references in assignments before deleting rubrics
        UPDATE public.assignments
        SET grading_rubric_id = NULL,
            meta_grading_rubric_id = NULL,
            self_review_rubric_id = NULL
        WHERE id = p_assignment_id AND (
            grading_rubric_id IS NOT NULL OR
            meta_grading_rubric_id IS NOT NULL OR
            self_review_rubric_id IS NOT NULL
        );

        -- Delete rubric-related data (in dependency order)
        DELETE FROM public.rubric_checks rc
        USING public.rubric_criteria rcrit
        JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
        JOIN public.rubrics r ON rp.rubric_id = r.id
        WHERE rc.rubric_criteria_id = rcrit.id AND r.assignment_id = p_assignment_id;

        DELETE FROM public.rubric_criteria rcrit
        USING public.rubric_parts rp
        JOIN public.rubrics r ON rp.rubric_id = r.id
        WHERE rcrit.rubric_part_id = rp.id AND r.assignment_id = p_assignment_id;

        DELETE FROM public.rubric_parts rp
        USING public.rubrics r
        WHERE rp.rubric_id = r.id AND r.assignment_id = p_assignment_id;

        DELETE FROM public.rubrics WHERE assignment_id = p_assignment_id;

        -- Delete assignment handout commits (before assignment due to FK constraint)
        DELETE FROM public.assignment_handout_commits WHERE assignment_id = p_assignment_id;

        -- Delete autograder commits (before autograder due to FK constraint)
        DELETE FROM public.autograder_commits ac
        USING public.autograder a
        WHERE ac.autograder_id = a.id AND a.id = p_assignment_id;

        -- Delete autograder regression tests (before autograder due to FK constraint)
        DELETE FROM public.autograder_regression_test art
        USING public.autograder a
        WHERE art.autograder_id = a.id AND a.id = p_assignment_id;

        -- Delete autograder if exists
        DELETE FROM public.autograder WHERE id = p_assignment_id;

        -- Delete gradebook column students (before gradebook column due to FK constraint)
        IF v_gradebook_column_id IS NOT NULL THEN
            DELETE FROM public.gradebook_column_students
            WHERE gradebook_column_id = v_gradebook_column_id;
        END IF;

        -- Delete gradebook column (using the assignment's gradebook_column_id)
        DELETE FROM public.gradebook_columns
        WHERE id = (SELECT gradebook_column_id FROM public.assignments WHERE id = p_assignment_id);

        -- Finally, delete the assignment itself
        DELETE FROM public.assignments
        WHERE id = p_assignment_id AND class_id = p_class_id;

        -- GitHub targets: students, then template, then solution, deduplicated case-insensitively
        -- and limited to well-formed owner/repo names, matching collectGitHubRepoTargets in
        -- supabase/functions/assignment-delete/repositoryCleanup.ts. Malformed student names are
        -- skipped; the edge function rejects a malformed template/solution before calling.
        FOR v_target IN
            -- Parsed exactly like parseGitHubRepoFullName: trim, split on '/', require exactly
            -- two parts, trim each, both non-empty. "Org / repo" is therefore Org/repo here too;
            -- a stricter rule would let the edge function's validation pass a target that this
            -- loop then silently drops, leaving the repository on GitHub with no row behind it.
            WITH raw AS (
                SELECT 'student'::text AS kind, name AS value, ord AS ord
                  FROM unnest(COALESCE(v_repository_names, ARRAY[]::text[])) WITH ORDINALITY AS u(name, ord)
                UNION ALL SELECT 'template', v_template_repo, 1000000001
                UNION ALL SELECT 'solution', v_grader_repo, 1000000002
            ), parts AS (
                SELECT kind, ord, string_to_array(btrim(value), '/') AS p
                  FROM raw WHERE btrim(value) <> ''
            ), parsed AS (
                SELECT kind, ord, btrim(p[1]) AS org, btrim(p[2]) AS repo
                  FROM parts WHERE cardinality(p) = 2
            ), valid AS (
                SELECT kind, ord, org, repo, org || '/' || repo AS full_name,
                       row_number() OVER (PARTITION BY lower(org || '/' || repo) ORDER BY ord) AS dup
                  FROM parsed
                 WHERE org <> '' AND repo <> ''
            )
            SELECT kind, full_name, org, repo
              FROM valid WHERE dup = 1 ORDER BY ord
        LOOP
            v_github_repositories := v_github_repositories
                || jsonb_build_object('kind', v_target.kind, 'full_name', v_target.full_name);
            IF p_enqueue_github_archives THEN
                -- Same debug_id shape as buildAssignmentDeleteArchiveDebugId.
                PERFORM public.enqueue_github_archive_repo(
                    p_class_id,
                    v_target.org,
                    v_target.repo,
                    format('assignment-delete-%s-%s-%s-%s', p_assignment_id, v_target.kind, v_index + 1,
                           left(regexp_replace(v_target.repo, '[^a-zA-Z0-9_.-]+', '-', 'g'), 80))
                );
                v_archives_queued := v_archives_queued + 1;
            END IF;
            v_index := v_index + 1;
        END LOOP;

        RETURN jsonb_build_object(
            'success', true,
            'message', format('Assignment "%s" has been successfully deleted along with all related data.', v_assignment_title),
            'assignment_id', p_assignment_id,
            'class_id', p_class_id,
            'github_repositories', v_github_repositories,
            'github_archives_queued', v_archives_queued,
            'handout_syncs_cancelled', v_syncs_cancelled
        );

    EXCEPTION
        WHEN OTHERS THEN
            RAISE;
    END;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Not callable through PostgREST by anon/authenticated
-- ---------------------------------------------------------------------------
-- Functions get EXECUTE for PUBLIC by default, and both of these are SECURITY DEFINER with no
-- caller check, so until 2026-10-15 anyone holding the anon key could delete any assignment
-- or queue an archive of any repository the GitHub app can reach. The earlier
-- `REVOKE ... FROM authenticated` (20250804164850) was a no-op: authenticated inherits PUBLIC.
-- Revoked by hand in production on 2026-10-15 (as supabase_admin, the grantor; a REVOKE run
-- as postgres silently leaves supabase_admin's grants in place). This migration also runs as
-- supabase_admin (migrations-job.yaml), so these revokes take effect.

REVOKE ALL ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.enqueue_github_archive_repo(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_archive_repo(bigint, text, text, text) TO service_role, postgres;

COMMENT ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean) IS
  'Deletes an assignment and all its associated data in one transaction. With p_enqueue_github_archives, also queues archive_repo_and_lock for every deleted repository plus the template and grader repos, so GitHub cleanup commits or rolls back with the delete. Cancels queued sync_repo_to_handout jobs for the deleted repositories. Returns the GitHub targets it removed. service_role/postgres only.';
