-- Push-direct submissions (PushDirectSubmission.ts) keep their bookkeeping consistent across hosts and
-- across retries.
--
-- 1. submissions.ingestion_pending: true from the moment a push-direct row is inserted until its files
--    are ingested and its verdict (accepted, or retained as a rejection) is written. The insert trigger
--    gives the row a grading review before ingestion starts, so the review is not proof that ingestion
--    finished: a worker stopped between the insert and the ingestion left an active, fileless row that
--    a redelivery took for a completed submission. Cleanup sets it too, so a row whose cleanup stopped
--    partway is never restored as the student's active submission. Every other writer leaves the
--    default, false.
--
-- 2. The non-PR uniqueness key includes repository_id. Repository names are unique per provider since
--    20261118140100_repository_names_per_provider.sql, so `org/repo` on GitHub and on Forgejo are
--    different repositories, and a name-only key made a Forgejo push collide with a GitHub submission
--    for the same name and sha. The key is the old one with coalesce(repository_id, 0) in front, and
--    keeps the old index's default NULL handling: upload and manual submissions store repository, sha
--    and repository_id as NULL with run_attempt 1 and run_number = the student's ordinal, so under NULLS
--    NOT DISTINCT two students' first uploads would collide. Adding a column to the old key can only
--    separate rows, so every row that satisfies the old index satisfies this one.
--
-- 3. promote_push_direct_submission: the force-push promotion as one transaction that refuses when a
--    newer submission has been recorded since the caller re-read the branch head.

ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS ingestion_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.submissions.ingestion_pending IS
  'True while a push-direct submission''s files and verdict are still being written, or after its cleanup '
  'stopped partway. Such a row is not a completed submission and is never restored as the active one.';

CREATE UNIQUE INDEX IF NOT EXISTS submissions_repository_id_sha_run_unique
  ON public.submissions ((coalesce(repository_id, 0)), repository, sha, run_number, run_attempt)
  WHERE submitted_via IS DISTINCT FROM 'pr';

DROP INDEX IF EXISTS public.submissions_repository_sha_run_unique;

-- Promote an existing submission for a force-push back to its sha, demoting whatever is active for the
-- same submitter. Returns:
--   'promoted'    the submission is now the submitter's active one;
--   'superseded'  a submission newer than p_newer_than_submission_id exists for the submitter, so a
--                 push accepted after the caller's head check owns the active slot, and nothing changed;
--   'missing'     no such submission.
--
-- The caller reads the submitter's highest submission id, then re-reads the branch head, then calls
-- this. A push accepted after that head read inserts a row with a higher id: if it is committed first,
-- this refuses; if it commits afterwards, its insert trigger demotes the row promoted here, which is the
-- right outcome; if the two overlap, the one-active unique indexes reject the second activation and the
-- caller's retry sees the newer row. The demote and the activation are one transaction, so a failure
-- between them can no longer leave the submitter with nothing active.
CREATE OR REPLACE FUNCTION public.promote_push_direct_submission(
  p_submission_id bigint,
  p_newer_than_submission_id bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub public.submissions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM public.submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  -- Serialize promotions for one submitter, so two deliveries cannot interleave their demote and
  -- activate steps.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'promote_push_direct_submission:' || v_sub.assignment_id::text || ':' ||
        coalesce('g' || v_sub.assignment_group_id::text, 'p' || v_sub.profile_id::text),
      0
    )
  );

  -- Scoped exactly like submissions_one_active_individual_per_student /
  -- submissions_one_active_group_per_group: the group for a group submission, the individual otherwise.
  IF EXISTS (
    SELECT 1 FROM public.submissions s
    WHERE s.assignment_id = v_sub.assignment_id
      AND s.id > p_newer_than_submission_id
      AND s.id <> v_sub.id
      AND (
        (v_sub.assignment_group_id IS NOT NULL AND s.assignment_group_id = v_sub.assignment_group_id)
        OR (v_sub.assignment_group_id IS NULL AND s.assignment_group_id IS NULL AND s.profile_id = v_sub.profile_id)
      )
  ) THEN
    RETURN 'superseded';
  END IF;

  UPDATE public.submissions s
     SET is_active = false
   WHERE s.assignment_id = v_sub.assignment_id
     AND s.is_active
     AND s.id <> v_sub.id
     AND (
       (v_sub.assignment_group_id IS NOT NULL AND s.assignment_group_id = v_sub.assignment_group_id)
       OR (v_sub.assignment_group_id IS NULL AND s.assignment_group_id IS NULL AND s.profile_id = v_sub.profile_id)
     );

  UPDATE public.submissions SET is_active = true WHERE id = v_sub.id AND NOT is_active;
  RETURN 'promoted';
END;
$$;

REVOKE ALL ON FUNCTION public.promote_push_direct_submission(bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_push_direct_submission(bigint, bigint) TO service_role;
