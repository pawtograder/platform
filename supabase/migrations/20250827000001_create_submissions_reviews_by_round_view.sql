-- purpose: create a view that returns one row per student per assignment with
--          scores aggregated by review_round for both private (all reviews)
--          and public (released reviews only) contexts. this restores the
--          previous one-row-per-student guarantee while supporting multiple
--          review rounds.
-- affected: public.submissions, public.submission_reviews, public.rubrics,
--           public.user_roles, public.assignment_groups_members, public.assignments
-- notes: the view is created with security_invoker so underlying rls policies
--        continue to apply. the private/public separation is encoded in the two
--        jsonb columns; consumers should choose the appropriate map based on
--        execution context.

drop view if exists public.submissions_with_reviews_by_round_for_assignment;

create or replace view public.submissions_with_reviews_by_round_for_assignment
with ("security_invoker"='true')
as
with
  assignment_students as (
    -- each student in the class of each assignment
    select distinct
      ur.private_profile_id,
      a.class_id,
      a.id as assignment_id,
      a.slug as assignment_slug
    from public.assignments a
    join public.user_roles ur
      on ur.class_id = a.class_id
     and ur.role = 'student'::public.app_role
  ),
  individual_submissions as (
    -- active individual submissions
    select
      ast.private_profile_id,
      ast.class_id,
      ast.assignment_id,
      ast.assignment_slug,
      s.id as submission_id
    from assignment_students ast
    join public.submissions s
      on s.assignment_id = ast.assignment_id
     and s.profile_id = ast.private_profile_id
     and s.is_active = true
     and s.assignment_group_id is null
  ),
  group_submissions as (
    -- active group submissions (map back to each member)
    select
      ast.private_profile_id,
      ast.class_id,
      ast.assignment_id,
      ast.assignment_slug,
      s.id as submission_id
    from assignment_students ast
    join public.assignment_groups_members agm
      on agm.assignment_id = ast.assignment_id
     and agm.profile_id = ast.private_profile_id
    join public.submissions s
      on s.assignment_id = ast.assignment_id
     and s.assignment_group_id = agm.assignment_group_id
     and s.is_active = true
  ),
  chosen_submission as (
    -- prefer individual submission; otherwise use group submission
    select
      ast.private_profile_id,
      ast.class_id,
      ast.assignment_id,
      ast.assignment_slug,
      coalesce(isub.submission_id, gsub.submission_id) as submission_id
    from assignment_students ast
    left join individual_submissions isub
      on isub.private_profile_id = ast.private_profile_id
     and isub.assignment_id = ast.assignment_id
    left join group_submissions gsub
      on gsub.private_profile_id = ast.private_profile_id
     and gsub.assignment_id = ast.assignment_id
  )
select
  cs.class_id,
  cs.assignment_id,
  cs.assignment_slug,
  cs.private_profile_id as student_private_profile_id,
  -- private map: includes all reviews regardless of release
  (
    select coalesce(jsonb_object_agg(x.review_round::text, x.total_score), '{}'::jsonb)
    from (
      select distinct on (r.review_round)
        r.review_round,
        sr.total_score
      from public.submission_reviews sr
      join public.rubrics r on r.id = sr.rubric_id
      where sr.submission_id = cs.submission_id
      order by r.review_round, sr.completed_at desc nulls last, sr.id desc
    ) x
  ) as scores_by_round_private,
  -- public map: only reviews released to students
  (
    select coalesce(jsonb_object_agg(x.review_round::text, x.total_score), '{}'::jsonb)
    from (
      select distinct on (r.review_round)
        r.review_round,
        sr.total_score
      from public.submission_reviews sr
      join public.rubrics r on r.id = sr.rubric_id
      where sr.submission_id = cs.submission_id
        and sr.released = true
      order by r.review_round, sr.completed_at desc nulls last, sr.id desc
    ) x
  ) as scores_by_round_public
from chosen_submission cs;

comment on view public.submissions_with_reviews_by_round_for_assignment is
'One row per student per assignment with per-review_round score maps. Private map includes all reviews; public map only includes released reviews.';




-- Restore the original recalculate_new_gradebook_column_students function
CREATE OR REPLACE FUNCTION public.recalculate_new_gradebook_column_students()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    messages jsonb[];
BEGIN
    -- Build messages for all newly inserted gradebook column students
    -- Only for columns that have a non-null score_expression
    SELECT array_agg(
        jsonb_build_object(
            'gradebook_column_id', gcs.gradebook_column_id,
            'student_id', gcs.student_id,
            'gradebook_column_student_id', gcs.id,
            'is_private', gcs.is_private,
            'reason', 'gradebook_column_student_new_gradebook_column_students',
            'trigger_id', NEW.id
        )
    )
    INTO messages
    FROM new_table gcs
    JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
    WHERE gc.score_expression IS NOT NULL;

    -- Send messages using helper function
    PERFORM public.send_gradebook_recalculation_messages(messages);

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_recalculate_dependent_columns_on_review ON public.submission_reviews;

CREATE CONSTRAINT TRIGGER trigger_recalculate_dependent_columns_on_review
  AFTER INSERT OR UPDATE ON public.submission_reviews
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.submission_review_recalculate_dependent_columns();

CREATE OR REPLACE FUNCTION "public"."call_edge_function_internal_post_payload"("url_path" "text", "headers" "jsonb" DEFAULT '{}'::"jsonb", "payload" "jsonb" DEFAULT '{}'::"jsonb", "timeout_ms" integer DEFAULT 1000) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
  DECLARE
    request_id bigint;
    supabase_project_url text;
    full_url text;
    edge_function_secret text;
    merged_headers jsonb;
  BEGIN
    IF url_path IS NULL OR url_path = 'null' THEN
      RAISE EXCEPTION 'url_path argument is missing';
    END IF;

    -- Retrieve the base URL from the Vault
    SELECT decrypted_secret INTO supabase_project_url 
    FROM vault.decrypted_secrets 
    WHERE name = 'supabase_project_url';

    IF supabase_project_url IS NULL OR supabase_project_url = 'null' THEN
      RAISE EXCEPTION 'supabase_project_url secret is missing or invalid';
    END IF;

    full_url := supabase_project_url || url_path;

    -- Retrieve the edge function secret from the Vault
    SELECT decrypted_secret INTO edge_function_secret
    FROM vault.decrypted_secrets
    WHERE name = 'edge-function-secret';

    IF edge_function_secret IS NULL OR edge_function_secret = 'null' THEN
      RAISE EXCEPTION 'edge-function-secret is missing or invalid';
    END IF;

    -- Merge the secret into the headers
    merged_headers := headers || jsonb_build_object('x-edge-function-secret', edge_function_secret);

      SELECT http_post INTO request_id FROM net.http_post(
        full_url,
        payload,
        '{}'::jsonb,
        merged_headers,
        timeout_ms
      );

  END;
$$;


-- purpose: call edge function to recompute dependencies for other gradebook columns
--          when a new gradebook column is inserted
-- notes: uses public.call_edge_function_internal which injects the edge secret

CREATE OR REPLACE FUNCTION public.on_gradebook_column_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Invoke edge function with context to recompute dependencies in same gradebook
  PERFORM public.call_edge_function_internal_post_payload(
    '/functions/v1/gradebook-column-inserted',
    '{"Content-type":"application/json"}'::jsonb,
    jsonb_build_object(
      'class_id', NEW.class_id,
      'gradebook_id', NEW.gradebook_id,
      'new_column_id', NEW.id
    ),
    5000
  );
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_on_gradebook_column_inserted'
  ) THEN
    DROP TRIGGER trg_on_gradebook_column_inserted ON public.gradebook_columns;
  END IF;
END$$;

CREATE TRIGGER trg_on_gradebook_column_inserted
AFTER INSERT ON public.gradebook_columns
FOR EACH ROW
EXECUTE FUNCTION public.on_gradebook_column_inserted();

COMMENT ON FUNCTION public.on_gradebook_column_inserted() IS 'After-insert hook for gradebook_columns: calls edge function to recompute dependencies for other columns in the same gradebook.';
