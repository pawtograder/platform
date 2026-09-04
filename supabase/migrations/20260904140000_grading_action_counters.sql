-- Monotonic per-class counters behind pawtograder_grading_actions_total.
--
-- ---------------------------------------------------------------------------
-- WHY: the exporter query this replaces was NOT a counter
-- ---------------------------------------------------------------------------
-- charts/pawtograder/templates/monitoring.yaml computed pawtograder_grading_actions
-- as a live COUNT(*) over submission_comments / submission_file_comments /
-- submission_artifact_comments / submission_reviews. That value can go DOWN in
-- two ways, and Prometheus reads any decrease of a COUNTER as a reset, which
-- rate()/increase() render as a phantom burst the size of the whole remaining
-- total:
--
--   1. HARD DELETES. public.delete_assignment_with_all_data()
--      (20260109094216_fix-delete-assignment-jsonb-bug.sql) hard-deletes all
--      three comment tables and submission_reviews for the assignment. The
--      "soft deletes are included so the counter stays monotonic" reasoning in
--      monitoring.yaml was correct about deleted_at and simply did not cover
--      this path.
--   2. BULK UNRELEASE. submission_reviews.released is a mutable boolean and
--      unrelease_all_grading_reviews_for_assignment() flips it back to false
--      for a whole assignment from the instructor UI. This was previously
--      documented as an accepted wart, but the damage is wider than the note
--      admitted: the "Grading actions (1h)" stat and the "Top classes by recent
--      activity" table sum ACROSS kinds, so a bulk unrelease corrupts those
--      panels too, not just the by-kind series.
--
-- Documenting either one is not enough for a dashboard that gets read during a
-- grading crunch: the panel does not read "stale", it reads "huge spike".
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS CHEAP, contrary to the earlier cost analysis
-- ---------------------------------------------------------------------------
-- The WS-APP wave rejected a trigger-maintained counter as "a new trigger on
-- the comment insert hot path to save 0.12% of one core". That trigger already
-- exists. class_metrics_submission_comments_counter()
-- (20250928001347_class_metrics_performance.sql) has fired AFTER INSERT on all
-- four comment tables since September 2025; this migration only adds columns to
-- the UPDATE it already issues. No new trigger, no new per-row invocation, no
-- extra statement — the same single-row UPDATE now touches one more column.
--
-- submission_reviews is the one genuinely new trigger, and it is scoped:
-- AFTER UPDATE OF released with a WHEN clause, so it is not entered at all for
-- the ordinary score/completed_at updates that dominate that table's write
-- volume. It fires once per review that actually transitions to released.
--
-- Dropping the scan also removes the exporter's cache_seconds: 300, which was
-- itself a problem — a 300s-cached counter makes rate(...[1m]) alternate
-- between zero and a five-minutes-in-one-scrape spike. The counters below are a
-- one-row-per-class read, so the exporter can serve them at every scrape.
--
-- ---------------------------------------------------------------------------
-- SEMANTICS
-- ---------------------------------------------------------------------------
-- These count grading ACTIONS (events), not surviving rows. A retracted
-- comment, a deleted assignment and an unreleased review all still happened.
-- The absolute value can therefore drift above the live row count; that is
-- correct and, in any case, invisible, because every panel reads these through
-- increase()/rate() where a constant offset cancels.
--
-- submission_regrade_request_comments is deliberately EXCLUDED from the two
-- comment counters (it keeps feeding submission_comments_total as before):
-- students write those, so they are not grading actions, and the scan being
-- replaced did not count them either. Keeping the metric's meaning identical
-- across the switch is what makes the counter continuous rather than stepping.

ALTER TABLE public.class_metrics_totals
  ADD COLUMN IF NOT EXISTS grading_actions_comment_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grading_actions_rubric_check_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grading_actions_release_total bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.class_metrics_totals.grading_actions_comment_total IS
  'Monotonic count of free-text grading comments ever inserted in this class (submission_comments + submission_file_comments + submission_artifact_comments with rubric_check_id IS NULL). Insert-only; never decremented. Backs pawtograder_grading_actions_total{kind="comment"}.';
COMMENT ON COLUMN public.class_metrics_totals.grading_actions_rubric_check_total IS
  'Monotonic count of rubric-check grading comments ever inserted in this class (same three tables, rubric_check_id IS NOT NULL). Backs pawtograder_grading_actions_total{kind="rubric_check"}.';
COMMENT ON COLUMN public.class_metrics_totals.grading_actions_release_total IS
  'Monotonic count of submission_reviews release EVENTS in this class (insert with released, or an update flipping released false -> true). Unlike COUNT(*) WHERE released, a bulk unrelease does not decrease it. Backs pawtograder_grading_actions_total{kind="release"}.';

-- ---------------------------------------------------------------------------
-- Comment counters: extend the trigger function that already runs.
-- ---------------------------------------------------------------------------
-- Fired by class_metrics_submission_comments_trg,
-- class_metrics_submission_artifact_comments_trg,
-- class_metrics_submission_file_comments_trg and
-- class_metrics_submission_regrade_request_comments_trg. Only the first three
-- carry rubric_check_id, which is why the regrade-comment table is branched out
-- FIRST: plpgsql resolves NEW.<field> when the expression is evaluated, so a
-- reference to a column that table does not have must not be reachable for it.
CREATE OR REPLACE FUNCTION public.class_metrics_submission_comments_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'submission_regrade_request_comments' THEN
    UPDATE public.class_metrics_totals
    SET submission_comments_total = submission_comments_total + 1,
        updated_at = now()
    WHERE class_id = NEW.class_id;
  ELSIF NEW.rubric_check_id IS NOT NULL THEN
    UPDATE public.class_metrics_totals
    SET submission_comments_total = submission_comments_total + 1,
        grading_actions_rubric_check_total = grading_actions_rubric_check_total + 1,
        updated_at = now()
    WHERE class_id = NEW.class_id;
  ELSE
    UPDATE public.class_metrics_totals
    SET submission_comments_total = submission_comments_total + 1,
        grading_actions_comment_total = grading_actions_comment_total + 1,
        updated_at = now()
    WHERE class_id = NEW.class_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Release counter: the one new trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.class_metrics_grading_releases_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.class_metrics_totals
  SET grading_actions_release_total = grading_actions_release_total + 1,
      updated_at = now()
  WHERE class_id = NEW.class_id;

  RETURN NEW;
END;
$$;

-- UPDATE OF released + a WHEN clause: the trigger is not entered for the score,
-- completed_at and rubric-assignment updates that make up nearly all of this
-- table's write traffic. A bulk release of one assignment fires it once per
-- review, each a single-row UPDATE of one class_metrics_totals row inside the
-- same transaction — the same shape as a bulk comment insert.
DROP TRIGGER IF EXISTS class_metrics_grading_releases_update_trg ON public.submission_reviews;
CREATE TRIGGER class_metrics_grading_releases_update_trg
AFTER UPDATE OF released ON public.submission_reviews
FOR EACH ROW
WHEN (NEW.released AND NOT OLD.released)
EXECUTE FUNCTION public.class_metrics_grading_releases_counter();

DROP TRIGGER IF EXISTS class_metrics_grading_releases_insert_trg ON public.submission_reviews;
CREATE TRIGGER class_metrics_grading_releases_insert_trg
AFTER INSERT ON public.submission_reviews
FOR EACH ROW
WHEN (NEW.released)
EXECUTE FUNCTION public.class_metrics_grading_releases_counter();

-- ---------------------------------------------------------------------------
-- Backfill.
-- ---------------------------------------------------------------------------
-- One pass over the comment tables and submission_reviews. This is the same
-- ~350ms full scan the exporter used to run every 5 minutes forever; here it
-- runs exactly once, inside the migration transaction.
--
-- The backfill counts SURVIVING rows, so it starts below the true historical
-- number of actions (anything already hard-deleted is gone, and releases that
-- have since been retracted read as zero). That is fine and is the reason these
-- are only ever read through increase()/rate(): the deficit is a constant
-- offset from the first scrape onwards, and only the deltas after that are
-- plotted.
WITH totals AS (
  SELECT c.id AS class_id,
         COALESCE(cm.n_comment, 0)      AS n_comment,
         COALESCE(cm.n_rubric_check, 0) AS n_rubric_check,
         COALESCE(rel.n_release, 0)     AS n_release
  FROM public.classes c
  LEFT JOIN (
    SELECT class_id,
           COUNT(*) FILTER (WHERE rubric_check_id IS NULL)     AS n_comment,
           COUNT(*) FILTER (WHERE rubric_check_id IS NOT NULL) AS n_rubric_check
    FROM (
      SELECT class_id, rubric_check_id FROM public.submission_comments
      UNION ALL
      SELECT class_id, rubric_check_id FROM public.submission_file_comments
      UNION ALL
      SELECT class_id, rubric_check_id FROM public.submission_artifact_comments
    ) x
    GROUP BY class_id
  ) cm ON cm.class_id = c.id
  LEFT JOIN (
    SELECT class_id, COUNT(*) AS n_release
    FROM public.submission_reviews
    WHERE released
    GROUP BY class_id
  ) rel ON rel.class_id = c.id
)
UPDATE public.class_metrics_totals mt
SET grading_actions_comment_total      = totals.n_comment,
    grading_actions_rubric_check_total = totals.n_rubric_check,
    grading_actions_release_total      = totals.n_release,
    updated_at = now()
FROM totals
WHERE mt.class_id = totals.class_id;
