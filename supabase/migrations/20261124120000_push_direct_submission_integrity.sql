-- Push-direct submissions (PushDirectSubmission.ts) keep their bookkeeping consistent across hosts and
-- across retries.
--
-- 1. submissions.ingestion_pending: true from the moment a push-direct row is inserted until its files
--    are ingested and its verdict (accepted, or retained as a rejection) is written. The insert trigger
--    gives the row a grading review before ingestion starts, so the review is not proof that ingestion
--    finished: a worker stopped between the insert and the ingestion left an active, fileless row that
--    a redelivery took for a completed submission. Cleanup sets it too, so a row whose cleanup stopped
--    partway is never restored as the student's active submission. Every other writer leaves the
--    default, false. It is the only completion marker: a NULL grading_review_id is not one, because
--    the AFTER INSERT hook provisions a grading review only when the assignment has a grading rubric,
--    so an accepted submission on an assignment without one is complete with no review.
--
--    Rows written before this column existed get the default, false, i.e. complete. The old marker
--    was a NULL grading_review_id, which cleanup (and a failed retention of a rejection) wrote along
--    with is_active = false. The backfill below keeps that classification for the rows it was right
--    about, and only those: an inactive push-direct row (run 0/0, submitted via git) with no grading
--    review, on an assignment that has a grading rubric, is marked pending. It is long past the stale
--    window, so the next delivery of its push reclaims it, as the old test did. A row on an
--    assignment without a grading rubric stays complete, which is the bug the old test had.
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
-- 3. promote_push_direct_submission: the force-push promotion as one transaction that refuses when
--    the submitter's submissions changed after the caller noted them and re-read the branch head:
--    either a newer submission was recorded (an insert, caught by the id fence) or another promotion
--    committed (caught by push_direct_promotion_versions, a per-submitter counter every promotion
--    bumps and every promotion compares against the value its caller read).

ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS ingestion_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.submissions.ingestion_pending IS
  'True while a push-direct submission''s files and verdict are still being written, or after its cleanup '
  'stopped partway. Such a row is not a completed submission and is never restored as the active one.';

UPDATE public.submissions s
   SET ingestion_pending = true
  FROM public.assignments a
 WHERE a.id = s.assignment_id
   AND a.grading_rubric_id IS NOT NULL
   AND s.grading_review_id IS NULL
   AND s.is_active IS NOT TRUE
   AND NOT s.ingestion_pending
   AND s.submitted_via = 'git'
   AND s.run_number = 0
   AND s.run_attempt = 0
   AND s.repository_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS submissions_repository_id_sha_run_unique
  ON public.submissions ((coalesce(repository_id, 0)), repository, sha, run_number, run_attempt)
  WHERE submitted_via IS DISTINCT FROM 'pr';

DROP INDEX IF EXISTS public.submissions_repository_sha_run_unique;

-- One row per submitter (per assignment) whose push-direct submission has ever been promoted. `version`
-- is bumped by every promotion, so a caller that noted it before re-reading the branch head can tell
-- whether another promotion committed in the meantime. Inserts are not counted here: the id fence
-- already catches those. The submitter key matches the one-active indexes: 'g<assignment_group_id>' for
-- a group submission, 'p<profile_id>' otherwise. Only the service role reads or writes it, through the
-- two functions below.
CREATE TABLE IF NOT EXISTS public.push_direct_promotion_versions (
  assignment_id bigint NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  submitter text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, submitter)
);

COMMENT ON TABLE public.push_direct_promotion_versions IS
  'Per-submitter count of push-direct force-push promotions, the compare-and-swap token for '
  'promote_push_direct_submission. Service role only.';

ALTER TABLE public.push_direct_promotion_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_direct_promotion_versions FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.push_direct_promotion_versions TO service_role;

-- The current promotion version for the submitter of p_submission_id; 0 if it was never promoted, or
-- if the submission does not exist (the promotion then returns 'missing').
CREATE OR REPLACE FUNCTION public.push_direct_promotion_version(p_submission_id bigint)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT v.version
       FROM public.submissions s
       JOIN public.push_direct_promotion_versions v
         ON v.assignment_id = s.assignment_id
        AND v.submitter = coalesce('g' || s.assignment_group_id::text, 'p' || s.profile_id::text)
      WHERE s.id = p_submission_id),
    0
  );
$$;

REVOKE ALL ON FUNCTION public.push_direct_promotion_version(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_direct_promotion_version(bigint) TO service_role;

-- Promote an existing submission for a force-push back to its sha, demoting whatever is active for the
-- same submitter. Returns:
--   'promoted'    the submission is now the submitter's active one;
--   'superseded'  the submitter's submissions changed since the caller noted them: a submission newer
--                 than p_newer_than_submission_id exists, or another promotion committed, so the
--                 caller's head check is stale and nothing changed;
--   'missing'     no such submission.
--
-- The caller notes the submitter's highest submission id and promotion version
-- (push_direct_promotion_version), then re-reads the branch head, then calls this with both.
--   - A push accepted after that head read inserts a row with a higher id: if it is committed first,
--     this refuses; if it commits afterwards, its insert trigger demotes the row promoted here, which
--     is the right outcome; if the two overlap, the one-active unique indexes reject the second
--     activation and the caller's retry sees the newer row.
--   - A promotion does not insert, so the id fence cannot see it. Two force-push deliveries can both
--     find their commit already recorded: A reads its fence and head A, the branch moves to B, B's
--     delivery promotes B, then A's call would promote A over the branch head. Every promotion bumps
--     the submitter's version under the advisory lock below, so A's call finds a version other than
--     the one it read, and refuses. The counter only grows, so there is no A-B-A.
-- The demote, the activation and the version bump are one transaction, so a failure between them can
-- no longer leave the submitter with nothing active.
--
-- Replaces the two-argument version an earlier revision of this migration created.
DROP FUNCTION IF EXISTS public.promote_push_direct_submission(bigint, bigint);

CREATE OR REPLACE FUNCTION public.promote_push_direct_submission(
  p_submission_id bigint,
  p_newer_than_submission_id bigint,
  p_expected_promotion_version bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub public.submissions%ROWTYPE;
  v_submitter text;
  v_version bigint;
BEGIN
  -- Lock order: the submitter's advisory lock first, then the target row. Taking the row lock first
  -- could deadlock: a concurrent reactivation can make the target active, so another promotion holding
  -- the advisory lock would then wait on this row in its demote step while this call waited on the
  -- advisory lock. So read the submitter scope without a lock, take the advisory lock, and only then
  -- lock and re-read the row. A submission's assignment and submitter never change, so the scope read
  -- unlocked is the one the locked row has.
  SELECT * INTO v_sub FROM public.submissions WHERE id = p_submission_id;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  v_submitter := coalesce('g' || v_sub.assignment_group_id::text, 'p' || v_sub.profile_id::text);

  -- Serialize promotions for one submitter, so two deliveries cannot interleave their demote and
  -- activate steps, or both pass the version check before either bumps it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('promote_push_direct_submission:' || v_sub.assignment_id::text || ':' || v_submitter, 0)
  );

  SELECT * INTO v_sub FROM public.submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  SELECT v.version INTO v_version
    FROM public.push_direct_promotion_versions v
   WHERE v.assignment_id = v_sub.assignment_id AND v.submitter = v_submitter;
  IF coalesce(v_version, 0) <> coalesce(p_expected_promotion_version, 0) THEN
    RETURN 'superseded';
  END IF;

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

  INSERT INTO public.push_direct_promotion_versions (assignment_id, submitter, version)
  VALUES (v_sub.assignment_id, v_submitter, 1)
  ON CONFLICT (assignment_id, submitter) DO UPDATE
    SET version = public.push_direct_promotion_versions.version + 1;
  RETURN 'promoted';
END;
$$;

REVOKE ALL ON FUNCTION public.promote_push_direct_submission(bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_push_direct_submission(bigint, bigint, bigint) TO service_role;
