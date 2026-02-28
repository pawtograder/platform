-- Migration: Complete sibling review assignments with same or subset rubric parts
-- 
-- When a review_assignment is completed, this trigger now:
-- 1. Finds other review_assignments for the same submission_review where the sibling's 
--    rubric parts are a SUBSET of (or equal to) the completing assignment's parts
-- 2. Marks those sibling assignments as complete (redundant grading support)
-- 3. Checks if ALL review_assignments are now complete
-- 4. If so, marks the submission_review as complete
--
-- Example: If Grader A completes parts {A, B, C}, then:
--   - Grader B with parts {A} gets marked complete (subset)
--   - Grader C with parts {A, B} gets marked complete (subset)
--   - Grader D with parts {A, B, C} gets marked complete (equal)
--   - Grader E with parts {A, D} does NOT get marked complete (D not in {A,B,C})
--
-- Uses pg_trigger_depth() to prevent redundant work in nested trigger executions.

CREATE OR REPLACE FUNCTION public.check_and_complete_submission_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
    target_submission_review_id bigint;
    target_rubric_id bigint;
    completing_user_id uuid;
    completing_review_assignment_id bigint;
    current_assignment_part_ids bigint[];
begin
    -- Only proceed if completed_at was just set (not updated from one non-null value to another)
    if OLD.completed_at is not null or NEW.completed_at is null then
        return NEW;
    end if;

    -- Get the submission review and rubric info
    target_submission_review_id := NEW.submission_review_id;
    completing_user_id := NEW.completed_by;
    completing_review_assignment_id := NEW.id;
    
    -- Add advisory lock to prevent race conditions during concurrent updates
    perform pg_advisory_xact_lock(target_submission_review_id);
    
    -- Get the rubric_id for this submission review with existence check
    select rubric_id into target_rubric_id
    from submission_reviews 
    where id = target_submission_review_id;
    
    -- Check if submission_review exists and raise warning if not
    if not found then
        raise warning 'submission_review with id % does not exist', target_submission_review_id;
        return NEW;
    end if;
    
    if target_rubric_id is null then
        return NEW;
    end if;

    -- Only perform sibling completion at the top level trigger (depth = 1)
    -- Nested triggers (from sibling completions) skip this to avoid redundant work
    if pg_trigger_depth() = 1 then
        -- Get the rubric part IDs assigned to the completing review_assignment
        -- NULL/empty array means "entire rubric" (no specific parts)
        select array_agg(rubric_part_id order by rubric_part_id) 
        into current_assignment_part_ids
        from review_assignment_rubric_parts
        where review_assignment_id = completing_review_assignment_id;

        -- STEP 1: Find and complete sibling review_assignments where sibling's parts
        -- are a SUBSET of (or equal to) the completing assignment's parts.
        -- This means all the work for the sibling has been done by the completing grader.
        update review_assignments ra_target
        set completed_at = NEW.completed_at,
            completed_by = completing_user_id
        where ra_target.submission_review_id = target_submission_review_id
          and ra_target.id != completing_review_assignment_id
          and ra_target.completed_at is null
          and (
              -- Case 1: Completing assignment covers entire rubric (no specific parts)
              -- Any sibling (with or without specific parts) is a subset
              (current_assignment_part_ids is null)
              or
              -- Case 2: Completing assignment has specific parts
              (current_assignment_part_ids is not null and (
                  -- Check if sibling has specific parts that are a subset of ours
                  -- Using @> operator: our_parts @> sibling_parts means "our parts contain all sibling's parts"
                  exists (
                      select 1 
                      from review_assignment_rubric_parts rarp
                      where rarp.review_assignment_id = ra_target.id
                  )
                  and
                  current_assignment_part_ids @> (
                      select array_agg(rarp.rubric_part_id)
                      from review_assignment_rubric_parts rarp
                      where rarp.review_assignment_id = ra_target.id
                  )
              ))
          );
    end if;

    -- STEP 2: Check if ALL review_assignments for this submission_review are now complete
    -- This runs at all trigger depths to ensure submission_review gets marked complete
    if not exists (
        select 1 
        from review_assignments ra
        where ra.submission_review_id = target_submission_review_id
          and ra.completed_at is null
    ) then
        -- All review assignments are complete, mark submission_review as complete
        -- (only if not already completed)
        update submission_reviews 
        set 
            completed_at = NEW.completed_at,
            completed_by = completing_user_id
        where id = target_submission_review_id
          and completed_at is null;
    end if;

    return NEW;
end;
$$;

COMMENT ON FUNCTION public.check_and_complete_submission_review() IS 
'Trigger function that handles review assignment completion with subset support:
1. When a review_assignment is marked complete, finds sibling assignments whose rubric parts
   are a SUBSET of (or equal to) the completing assignment''s parts
2. Marks those siblings as complete (supports redundant grading where multiple graders review the same work)
3. If ALL review_assignments for the submission_review are now complete, marks the submission_review as complete
4. The complete_remaining_review_assignments trigger on submission_reviews handles any remaining stragglers

Example: If grader completes parts {A,B,C}, siblings with {A}, {A,B}, or {A,B,C} are auto-completed.
Siblings with {A,D} or {D} are NOT auto-completed (not subsets).

Uses pg_trigger_depth() = 1 to only perform sibling completion at the top level, avoiding redundant work 
when nested triggers fire for the completed siblings.';

-- Index to optimize sibling lookup: finding incomplete review_assignments by submission_review_id
CREATE INDEX IF NOT EXISTS idx_review_assignments_submission_review_incomplete 
ON public.review_assignments (submission_review_id) 
WHERE completed_at IS NULL;
