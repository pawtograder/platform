-- CW-P6: delete Forgejo assignments, cleaning up their repos the way GitHub's are.
--
-- Depends on 20261121170100_forgejo_repo_archives.sql (forgejo_repo_archives, the repositories
-- AFTER DELETE trigger that queues a deleted Forgejo row, and the lifted repositories DELETE guard).
--
-- On GitHub, delete_assignment_with_all_data queues archive_repo_and_lock for every student repo,
-- the template and the solution repo in its own transaction, and assignment-delete then deletes a
-- small batch (five or fewer) outright. Until now the assignments_guard_forgejo_delete trigger
-- refused to delete a Forgejo assignment at all, because this function sent every name to GitHub.
--
-- Now:
--   1. delete_assignment_with_all_data splits the deleted repositories by host. GitHub names take
--      the GitHub path as before. A Forgejo assignment's student repos and its template are queued
--      in forgejo_repo_archives in the same transaction, and returned as `forgejo_repositories`
--      ({kind, full_name}) so assignment-delete can delete a small batch outright, as it does on
--      GitHub. Its solution repo stays on GitHub (D6) and is still a GitHub target.
--   2. Deleting a Forgejo assignment row any other way queues its template too, through an AFTER
--      DELETE trigger. Its student repos are queued by the repositories trigger when the rows go.
--   Deleting a course with assignments still fails on either host, with or without this migration:
--   assignment_self_review_settings.class_id references classes with NO ACTION while
--   assignments.self_review_setting_id is NOT NULL, so the class delete raises 23503. The trigger
--   in 2 would also cover that cascade if a later schema change made it possible.
--   3. The guard trigger is dropped.
--
-- Body is otherwise verbatim from 20261016120000_assignment_delete_atomic_archive.sql, the live
-- definition; the changes are the provider split of the deleted repositories, the template going
-- to GitHub only for a GitHub assignment, and the Forgejo targets queued and returned at the end.

CREATE OR REPLACE FUNCTION public.delete_assignment_with_all_data(
    p_assignment_id bigint,
    p_class_id bigint,
    p_enqueue_github_archives boolean DEFAULT false,
    p_expected_repository_ids bigint[] DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_assignment_title text;
    v_git_provider text;
    v_forgejo_names text[];
    v_forgejo_repositories jsonb := '[]'::jsonb;
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
    v_low_priority_sync_msg_ids bigint[];
    v_syncs_in_flight integer := 0;
    v_syncs_cancelled integer := 0;
BEGIN
    -- Only service_role and postgres may call this (see the REVOKE below); authorization of
    -- the human behind the request is the calling edge function's job.

    -- Check if assignment exists and belongs to the specified class
    SELECT title, template_repo, git_provider INTO v_assignment_title, v_template_repo, v_git_provider
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

    -- Lock this assignment's repository rows before looking at the queue. The only producer of
    -- handout syncs, queue_repository_syncs, locks the same rows (`FOR UPDATE OF r`, ordered by
    -- id, as here) before it enqueues. So a sync press either committed before this point, and
    -- its message is visible to the scan below, or it waits here and, once this transaction
    -- commits, finds the rows deleted and queues nothing. Without this lock it could enqueue
    -- after the scan and a worker could start on a repository this delete is about to archive.
    SELECT array_agg(id ORDER BY id) INTO v_repository_ids
      FROM (
        SELECT id FROM public.repositories
         WHERE assignment_id = p_assignment_id
         ORDER BY id
         FOR UPDATE
      ) locked;

    -- The repositories the caller ran its safety checks on (that each holds only template
    -- commits). A row created since then, e.g. by a repository-creation job that committed in
    -- between, has not been checked, and this call would archive it or, on the synchronous
    -- path, the edge function would DELETE it from GitHub, student work included. Now that the
    -- rows are locked the set cannot change, so compare it and let the caller re-check.
    IF p_expected_repository_ids IS NOT NULL
       AND COALESCE(v_repository_ids, ARRAY[]::bigint[])
           IS DISTINCT FROM COALESCE(ARRAY(SELECT DISTINCT u FROM unnest(p_expected_repository_ids) u ORDER BY u), ARRAY[]::bigint[])
    THEN
        RAISE EXCEPTION 'Cannot delete assignment: its repositories changed while the delete was being checked. Try again.'
            USING ERRCODE = 'serialization_failure';
    END IF;

    -- Handout syncs already queued for those repositories, on either queue the worker drains.
    -- An unclaimed one would write a sync branch into a repository that is about to be
    -- archived, so it is cancelled. A RUNNING one (defined below) cannot be
    -- stopped from here: deleting its queue row does not stop the worker holding the envelope,
    -- which may be past its row check and mutating GitHub. So the delete refuses and the
    -- caller retries once it finishes. FOR UPDATE keeps the answer true for the rest of this
    -- transaction, because pgmq.read claims with FOR UPDATE SKIP LOCKED. (read_ct = 0 with a
    -- future vt is a delayed requeue, not a claim.)
    --
    -- The refusal applies only to a caller that leaves GitHub cleanup to this function. A
    -- caller passing p_enqueue_github_archives = false is an assignment-delete from before this
    -- migration, which has ALREADY committed its archive jobs: refusing it would leave those
    -- jobs archiving an assignment that stays live, the very failure this migration fixes. It
    -- gets the old behaviour (delete, cancel only what is not running) during the rollout.
    IF v_repository_ids IS NOT NULL THEN
        -- What counts as RUNNING, not merely queued:
        --   * a claimed message: read_ct > 0 and still invisible; or
        --   * a message whose handler has planted its marker on the repository row. A handler
        --     that outlives its visibility timeout (a batch of 4 has been measured at ~420s
        --     against the chart's 300s default) has a message that LOOKS unclaimed again while
        --     its worker is still mutating GitHub. Before any GitHub write the handler sets
        --     sync_data = {status: in_progress, msg_id, ...} and overwrites it when it ends,
        --     so the marker lasts exactly as long as the handler. Only markers whose message is
        --     still in the queue count: one whose message has left it (archived when the
        --     handler ended, dead-lettered, or replaced by a requeue under a new msg_id) is
        --     stale, so a crashed worker cannot pin an assignment for good.
        --   * a message some worker has read (read_ct > 0) while a drain lease for its org is
        --     live. The marker is one value per repository, so two overlapping handlers for the
        --     same repository (H2 and H3: queue_repository_syncs serializes nothing per
        --     repository) share it, and the newer one can overwrite and then clear it while the
        --     older one, past its timeout, is still running. What does last for every handler is
        --     the org slot it runs under: a leaseholder renews async_worker_slots while it works
        --     and releases it only after every in-flight message finishes. The org is the one
        --     the slot allocator charges a sync to (claim_org_slot_and_read,
        --     20260914120000_async_lease_pin_org.sql): the owner in args.repository_full_name,
        --     lowercased, on the same queue. No new handler can pick these messages up while
        --     this transaction holds them, so a live slot means one that already has may still
        --     be running. It is coarse (any work for the org keeps the slot live), so it is
        --     applied only to messages that have been read at least once.
        --     With org slots disabled (orgSlotGlobalCap 0, the chart default) there is no lease
        --     to consult and this arm never fires; production runs with them enabled.
        -- The window before the marker is written needs no check: the worker plants it with a
        -- guarded UPDATE of these repository rows, which this transaction holds locked; after
        -- the commit that UPDATE matches nothing and the worker drops the job without touching
        -- GitHub (retireStaleSync: "the repository row is gone").
        --
        -- One locked scan per queue (FOR UPDATE is not allowed under UNION, but is in a CTE).
        WITH markers AS (
            -- CASE, not a WHERE conjunct: SQL does not promise to test the pattern before
            -- the cast, and a malformed marker must be ignored rather than fail the delete.
            SELECT CASE WHEN sync_data->>'msg_id' ~ '^[0-9]{1,18}$' THEN (sync_data->>'msg_id')::bigint END AS msg_id
              FROM public.repositories
             WHERE id = ANY (v_repository_ids)
               AND sync_data->>'status' = 'in_progress'
        ), main_q AS (
            SELECT q.msg_id,
                   (q.read_ct > 0 AND q.vt > clock_timestamp())
                   OR q.msg_id IN (SELECT msg_id FROM markers)
                   OR (q.read_ct > 0 AND EXISTS (
                         SELECT 1 FROM public.async_worker_slots sl
                          WHERE sl.queue_name = 'async_calls'
                            AND sl.org = lower(split_part(q.message->'args'->>'repository_full_name', '/', 1))
                            AND sl.expires_at > clock_timestamp())) AS running
              FROM pgmq.q_async_calls q
             WHERE q.message->>'method' = 'sync_repo_to_handout'
               AND q.message->'args'->>'repository_id' = ANY (v_repository_ids::text[])
               FOR UPDATE OF q
        ), low_q AS (
            SELECT q.msg_id,
                   (q.read_ct > 0 AND q.vt > clock_timestamp())
                   OR q.msg_id IN (SELECT msg_id FROM markers)
                   OR (q.read_ct > 0 AND EXISTS (
                         SELECT 1 FROM public.async_worker_slots sl
                          WHERE sl.queue_name = 'async_calls_low_priority'
                            AND sl.org = lower(split_part(q.message->'args'->>'repository_full_name', '/', 1))
                            AND sl.expires_at > clock_timestamp())) AS running
              FROM pgmq.q_async_calls_low_priority q
             WHERE q.message->>'method' = 'sync_repo_to_handout'
               AND q.message->'args'->>'repository_id' = ANY (v_repository_ids::text[])
               FOR UPDATE OF q
        )
        SELECT (SELECT array_agg(msg_id) FROM main_q WHERE NOT running),
               (SELECT array_agg(msg_id) FROM low_q WHERE NOT running),
               (SELECT count(*) FROM main_q WHERE running) + (SELECT count(*) FROM low_q WHERE running)
          INTO v_sync_msg_ids, v_low_priority_sync_msg_ids, v_syncs_in_flight;

        IF v_syncs_in_flight > 0 AND p_enqueue_github_archives THEN
            RAISE EXCEPTION 'Cannot delete assignment: % handout sync(s) for its repositories are running right now. Try again in a few minutes.',
                v_syncs_in_flight
                USING ERRCODE = 'object_in_use';
        END IF;

        IF v_sync_msg_ids IS NOT NULL THEN
            SELECT count(*) INTO v_syncs_cancelled FROM pgmq.delete('async_calls', v_sync_msg_ids);
        END IF;
        IF v_low_priority_sync_msg_ids IS NOT NULL THEN
            v_syncs_cancelled := v_syncs_cancelled
                + (SELECT count(*) FROM pgmq.delete('async_calls_low_priority', v_low_priority_sync_msg_ids));
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

        -- Delete repositories, keeping exactly what was removed: these are the cleanup targets,
        -- split by host. The Forgejo rows are also queued in forgejo_repo_archives by the
        -- repositories AFTER DELETE trigger (20261121170100_forgejo_repo_archives.sql).
        WITH deleted AS (
            DELETE FROM public.repositories WHERE assignment_id = p_assignment_id
            RETURNING id, repository, git_provider
        )
        SELECT array_agg(id ORDER BY id),
               array_agg(repository ORDER BY id) FILTER (WHERE git_provider = 'github'),
               array_agg(repository ORDER BY id) FILTER (WHERE git_provider = 'forgejo')
          INTO v_repository_ids, v_repository_names, v_forgejo_names
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
        -- A Forgejo assignment's students and template are on Forgejo (handled below); its
        -- solution (grader) repo stays on GitHub (D6), so it is still a GitHub target.
        -- and limited to well-formed owner/repo names, matching collectGitHubRepoTargets in
        -- supabase/functions/assignment-delete/repositoryCleanup.ts. Malformed student names are
        -- skipped; the edge function rejects a malformed template/solution before calling.
        FOR v_target IN
            -- Parsed exactly like parseGitHubRepoFullName: trim ASCII spaces, split on '/', require
            -- exactly two parts, trim each, and require GitHub's name characters in both. "Org /
            -- repo" is Org/repo on both sides; a tab, newline or non-breaking space is invalid on
            -- both sides. Any difference would let the edge function validate a target that this
            -- loop drops or queues malformed.
            WITH raw AS (
                SELECT 'student'::text AS kind, name AS value, ord AS ord
                  FROM unnest(COALESCE(v_repository_names, ARRAY[]::text[])) WITH ORDINALITY AS u(name, ord)
                UNION ALL SELECT 'template', v_template_repo, 1000000001 WHERE v_git_provider = 'github'
                UNION ALL SELECT 'solution', v_grader_repo, 1000000002
            ), parts AS (
                SELECT kind, ord, string_to_array(btrim(value, ' '), '/') AS p
                  FROM raw WHERE btrim(value, ' ') <> ''
            ), parsed AS (
                SELECT kind, ord, btrim(p[1], ' ') AS org, btrim(p[2], ' ') AS repo
                  FROM parts WHERE cardinality(p) = 2
            ), valid AS (
                SELECT kind, ord, org, repo, org || '/' || repo AS full_name,
                       row_number() OVER (PARTITION BY lower(org || '/' || repo) ORDER BY ord) AS dup
                  FROM parsed
                 WHERE org ~ '^[A-Za-z0-9._-]+$' AND repo ~ '^[A-Za-z0-9._-]+$'
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

        -- Forgejo targets: students, then the template, in the same {kind, full_name} shape,
        -- lowercased like every Forgejo name Pawtograder stores. All of them are queued for
        -- forgejo-reconciler to archive, inside this transaction, whatever cleanup the caller
        -- then does: the queue is the guarantee and an immediate delete only an optimisation,
        -- as on GitHub. Students were queued by the trigger; ON CONFLICT makes this a no-op
        -- for them. The template is queued here (and by the assignments AFTER DELETE trigger).
        WITH raw AS (
            SELECT 'student'::text AS kind, lower(btrim(name)) AS full_name, ord
              FROM unnest(COALESCE(v_forgejo_names, ARRAY[]::text[])) WITH ORDINALITY AS u(name, ord)
            UNION ALL
            SELECT 'template', lower(btrim(v_template_repo)), 1000000001 WHERE v_git_provider = 'forgejo'
        ), valid AS (
            SELECT kind, full_name, ord,
                   row_number() OVER (PARTITION BY full_name ORDER BY ord) AS dup
              FROM raw
             WHERE full_name ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'full_name', full_name) ORDER BY ord), '[]'::jsonb)
          INTO v_forgejo_repositories
          FROM valid WHERE dup = 1;

        PERFORM public.queue_forgejo_repo_archives(
            ARRAY(SELECT p_class_id FROM jsonb_array_elements(v_forgejo_repositories)),
            ARRAY(SELECT t->>'full_name' FROM jsonb_array_elements(v_forgejo_repositories) t)
        );

        RETURN jsonb_build_object(
            'success', true,
            'message', format('Assignment "%s" has been successfully deleted along with all related data.', v_assignment_title),
            'assignment_id', p_assignment_id,
            'class_id', p_class_id,
            'github_repositories', v_github_repositories,
            'github_archives_queued', v_archives_queued,
            'forgejo_repositories', v_forgejo_repositories,
            'handout_syncs_cancelled', v_syncs_cancelled
        );

    EXCEPTION
        WHEN OTHERS THEN
            RAISE;
    END;
END;
$function$;

COMMENT ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint, boolean, bigint[]) IS
  'Deletes an assignment and all its associated data in one transaction. With p_enqueue_github_archives, also queues archive_repo_and_lock for every deleted GitHub repository plus a GitHub template and the grader repo, so GitHub cleanup commits or rolls back with the delete. A Forgejo assignment''s repos and template are queued in forgejo_repo_archives in the same transaction. Locks the repositories and cancels their queued sync_repo_to_handout jobs, refusing (55006) while one is running (claimed, or an in_progress marker whose message is still queued). Returns the GitHub and Forgejo targets it removed. false = legacy caller that queued its own archives. service_role/postgres only.';

-- A Forgejo assignment row deleted without delete_assignment_with_all_data still has its handout archived.
-- (A course's cascade would fire this too, but that cascade can't complete today; see the header.) Its
-- student repos are queued by forgejo_repo_archive_on_delete when their rows go.
CREATE OR REPLACE FUNCTION public.queue_forgejo_template_archive_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.git_provider = 'forgejo' AND OLD.template_repo IS NOT NULL THEN
    PERFORM public.queue_forgejo_repo_archives(ARRAY[OLD.class_id], ARRAY[lower(btrim(OLD.template_repo))]);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_forgejo_template_archive_on_delete() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS forgejo_template_archive_on_delete ON public.assignments;
CREATE TRIGGER forgejo_template_archive_on_delete
  AFTER DELETE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.queue_forgejo_template_archive_on_delete();

-- The cleanup above now exists, so the refusal goes. assignments_validate_git_provider keeps its
-- INSERT/UPDATE checks (assignments_validate_git_provider trigger); its DELETE branch is no longer reached.
DROP TRIGGER IF EXISTS assignments_guard_forgejo_delete ON public.assignments;
