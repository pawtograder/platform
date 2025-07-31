-- Add completed_at column to review_assignments
alter table review_assignments add column completed_at timestamp with time zone;

-- Add completed_by column to review_assignments
alter table review_assignments add column completed_by uuid references profiles(id);

-- Create trigger function to auto-complete submission reviews when all review assignments are done
create or replace function check_and_complete_submission_review()
returns trigger
language plpgsql
security definer
as $$
declare
    target_submission_review_id bigint;
    target_rubric_id bigint;
    all_rubric_parts_count integer;
    completed_review_assignments_count integer;
    completing_user_id uuid;
begin
    -- Only proceed if completed_at was just set (not updated from one non-null value to another)
    if OLD.completed_at is not null or NEW.completed_at is null then
        return NEW;
    end if;

    -- Get the submission review and rubric info
    target_submission_review_id := NEW.submission_review_id;
    completing_user_id := NEW.completed_by;
    
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

    -- Check if the submission review is already completed
    if exists (
        select 1 from submission_reviews 
        where id = target_submission_review_id 
        and completed_at is not null
    ) then
        return NEW;
    end if;

    -- Count total rubric parts for this rubric
    select count(*) into all_rubric_parts_count
    from rubric_parts 
    where rubric_id = target_rubric_id;

    -- Check if there are any rubric parts assigned to review assignments for this submission review
    if exists (
        select 1 
        from review_assignment_rubric_parts rarp
        join review_assignments ra on ra.id = rarp.review_assignment_id
        where ra.submission_review_id = target_submission_review_id
    ) then
        -- Case 1: Specific rubric parts are assigned
        -- Count completed review assignments that cover all rubric parts for this submission review
        -- We need to ensure that every rubric part has at least one completed review assignment
        select count(distinct rarp.rubric_part_id) into completed_review_assignments_count
        from review_assignment_rubric_parts rarp
        join review_assignments ra on ra.id = rarp.review_assignment_id
        where ra.submission_review_id = target_submission_review_id
        and ra.completed_at is not null;

        -- If all rubric parts have completed review assignments, complete the submission review
        if completed_review_assignments_count = all_rubric_parts_count then
            update submission_reviews 
            set 
                completed_at = NEW.completed_at,
                completed_by = completing_user_id
            where id = target_submission_review_id;
        end if;
    else
        -- Case 2: No specific rubric parts assigned (review assignments cover entire rubric)
        -- Check if all review assignments for this submission review are completed
        if not exists (
            select 1 
            from review_assignments ra
            where ra.submission_review_id = target_submission_review_id
            and ra.completed_at is null
        ) then
            update submission_reviews 
            set 
                completed_at = NEW.completed_at,
                completed_by = completing_user_id
            where id = target_submission_review_id;
        end if;
    end if;

    return NEW;
end;
$$;

-- Create trigger on review_assignments table
create trigger trigger_check_and_complete_submission_review
    after update on review_assignments
    for each row
    execute function check_and_complete_submission_review();

-- Create trigger function to auto-complete remaining review assignments when submission review is completed
create or replace function complete_remaining_review_assignments()
returns trigger
language plpgsql
security definer
as $$
begin
    -- Only proceed if completed_at was just set (not updated from one non-null value to another)
    if OLD.completed_at is not null or NEW.completed_at is null then
        return NEW;
    end if;

    -- Complete any remaining incomplete review assignments for this submission review
    update review_assignments 
    set 
        completed_at = NEW.completed_at,
        completed_by = NEW.completed_by
    where submission_review_id = NEW.id
    and completed_at is null;

    return NEW;
end;
$$;

-- Create trigger on submission_reviews table
create trigger trigger_complete_remaining_review_assignments
    after update on submission_reviews
    for each row
    execute function complete_remaining_review_assignments();


-- Performance optimization indexes for submissions_with_grades_for_assignment view
-- These indexes target the expensive joins identified in the query plan
-- Identified while testing review assignments feature


-- Index on submission_reviews profile lookup columns (used in multiple LEFT JOINs to profiles)
CREATE INDEX IF NOT EXISTS "idx_submission_reviews_grader" ON "public"."submission_reviews" USING "btree" ("grader");
CREATE INDEX IF NOT EXISTS "idx_submission_reviews_meta_grader" ON "public"."submission_reviews" USING "btree" ("meta_grader");
CREATE INDEX IF NOT EXISTS "idx_submission_reviews_completed_by" ON "public"."submission_reviews" USING "btree" ("completed_by");
CREATE INDEX IF NOT EXISTS "idx_submission_reviews_checked_by" ON "public"."submission_reviews" USING "btree" ("checked_by");

-- Composite indexes for submissions table to optimize joins
CREATE INDEX IF NOT EXISTS "idx_submissions_profile_assignment_active" ON "public"."submissions" USING "btree" ("profile_id", "assignment_id", "is_active");
CREATE INDEX IF NOT EXISTS "idx_submissions_assignment_group_assignment_active" ON "public"."submissions" USING "btree" ("assignment_group_id", "assignment_id", "is_active") WHERE "assignment_group_id" IS NOT NULL;

-- Composite indexes for assignment_groups_members to optimize joins
CREATE INDEX IF NOT EXISTS "idx_assignment_groups_members_profile_assignment" ON "public"."assignment_groups_members" USING "btree" ("profile_id", "assignment_id");
CREATE INDEX IF NOT EXISTS "idx_assignment_groups_members_assignment_group_assignment" ON "public"."assignment_groups_members" USING "btree" ("assignment_group_id", "assignment_id");

-- Optimize user_roles filtering for the student role
CREATE INDEX IF NOT EXISTS "idx_user_roles_role_class_profile" ON "public"."user_roles" USING "btree" ("role", "class_id", "private_profile_id");

-- Composite index for assignment_due_date_exceptions to optimize the expensive nested loop
CREATE INDEX IF NOT EXISTS "idx_assignment_due_date_exceptions_student_assignment_group" ON "public"."assignment_due_date_exceptions" USING "btree" ("student_id", "assignment_group_id");

-- Index for grader_results lookup by submission_id
CREATE INDEX IF NOT EXISTS "idx_grader_results_submission_id_covering" ON "public"."grader_results" USING "btree" ("submission_id") INCLUDE ("grader_sha", "grader_action_sha");

-- Restructured submissions_with_grades_for_assignment view for better performance
-- This addresses the fundamental structural issues causing the 80M+ row filtering

DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment;

-- Create a more efficient view using CTEs and better join logic
CREATE OR REPLACE VIEW public.submissions_with_grades_for_assignment 
WITH (security_invoker='true') 
AS
WITH student_roles AS (
  -- Pre-filter student roles to reduce working set
  SELECT r.id, r.private_profile_id, r.class_id
  FROM user_roles r
  WHERE r.role = 'student'::app_role
),

-- Separate CTEs for individual and group submissions to avoid complex CASE logic
individual_submissions AS (
  SELECT 
    sr.id as user_role_id,
    sr.private_profile_id,
    sr.class_id,
    a.id as assignment_id,
    s.id as submission_id,
    NULL::bigint as assignment_group_id,
    a.due_date
  FROM student_roles sr
  INNER JOIN assignments a ON a.class_id = sr.class_id
  INNER JOIN submissions s ON (
    s.profile_id = sr.private_profile_id 
    AND s.assignment_id = a.id 
    AND s.is_active = true
  )
),

group_submissions AS (
  SELECT 
    sr.id as user_role_id,
    sr.private_profile_id,
    sr.class_id,
    a.id as assignment_id,
    s.id as submission_id,
    agm.assignment_group_id,
    a.due_date
  FROM student_roles sr
  INNER JOIN assignments a ON a.class_id = sr.class_id
  INNER JOIN assignment_groups_members agm ON (
    agm.profile_id = sr.private_profile_id 
    AND agm.assignment_id = a.id
  )
  INNER JOIN submissions s ON (
    s.assignment_group_id = agm.assignment_group_id 
    AND s.assignment_id = a.id 
    AND s.is_active = true
  )
),

-- Union individual and group submissions
all_submissions AS (
  SELECT * FROM individual_submissions
  UNION ALL
  SELECT * FROM group_submissions
),

-- Handle due date exceptions more efficiently
due_date_extensions AS (
  SELECT 
    COALESCE(student_id, ag.profile_id) as effective_student_id,
    COALESCE(ade.assignment_group_id, ag.assignment_group_id) as effective_assignment_group_id,
    sum(ade.tokens_consumed) as tokens_consumed,
    sum(ade.hours) as hours
  FROM assignment_due_date_exceptions ade
  LEFT JOIN assignment_groups_members ag ON ade.assignment_group_id = ag.assignment_group_id
  GROUP BY 
    COALESCE(student_id, ag.profile_id),
    COALESCE(ade.assignment_group_id, ag.assignment_group_id)
),

-- Main submission data with extensions
submissions_with_extensions AS (
  SELECT 
    asub.*,
    COALESCE(dde.tokens_consumed, 0) as tokens_consumed,
    COALESCE(dde.hours, 0) as hours
  FROM all_submissions asub
  LEFT JOIN due_date_extensions dde ON (
    dde.effective_student_id = asub.private_profile_id
    AND (
      (asub.assignment_group_id IS NULL AND dde.effective_assignment_group_id IS NULL)
      OR (asub.assignment_group_id = dde.effective_assignment_group_id)
    )
  )
)

-- Final selection with all joins
SELECT 
  swe.user_role_id as id,
  swe.class_id,
  swe.assignment_id,
  p.id as student_private_profile_id,
  p.name,
  p.sortable_name,
  s.id AS activesubmissionid,
  s.created_at,
  s.released,
  s.repository,
  s.sha,
  rev.total_autograde_score AS autograder_score,
  rev.grader,
  rev.meta_grader,
  rev.total_score,
  rev.tweak,
  rev.completed_by,
  rev.completed_at,
  rev.checked_at,
  rev.checked_by,
  graderprofile.name AS assignedgradername,
  metagraderprofile.name AS assignedmetagradername,
  completerprofile.name AS gradername,
  checkgraderprofile.name AS checkername,
  ag.name AS groupname,
  swe.tokens_consumed,
  swe.hours,
  swe.due_date,
  (swe.due_date + ('01:00:00'::interval * swe.hours::double precision)) AS late_due_date,
  ar.grader_sha,
  ar.grader_action_sha
FROM submissions_with_extensions swe
INNER JOIN profiles p ON p.id = swe.private_profile_id
INNER JOIN submissions s ON s.id = swe.submission_id
LEFT JOIN submission_reviews rev ON rev.id = s.grading_review_id
LEFT JOIN grader_results ar ON ar.submission_id = s.id
LEFT JOIN assignment_groups ag ON ag.id = swe.assignment_group_id
LEFT JOIN profiles completerprofile ON completerprofile.id = rev.completed_by
LEFT JOIN profiles graderprofile ON graderprofile.id = rev.grader
LEFT JOIN profiles metagraderprofile ON metagraderprofile.id = rev.meta_grader
LEFT JOIN profiles checkgraderprofile ON checkgraderprofile.id = rev.checked_by;


-- Performance optimization indexes for assignment_overview view
-- These indexes target the GROUP BY operations and WHERE clauses in the subqueries

-- Composite index for submissions aggregation (assignment_id, is_active)
-- This supports both the WHERE clause and GROUP BY efficiently
CREATE INDEX IF NOT EXISTS "idx_submissions_assignment_id_is_active" ON "public"."submissions" USING "btree" ("assignment_id", "is_active");

-- Composite index for submission_regrade_requests aggregation (assignment_id, status)  
-- This supports both the WHERE clause and GROUP BY efficiently
CREATE INDEX IF NOT EXISTS "idx_submission_regrade_requests_assignment_id_status" ON "public"."submission_regrade_requests" USING "btree" ("assignment_id", "status");

-- Index on assignments.class_id for filtering (the primary use case)
CREATE INDEX IF NOT EXISTS "idx_assignments_class_id_due_date" ON "public"."assignments" USING "btree" ("class_id", "due_date");

-- Covering index for assignments to avoid table lookups in the main query
CREATE INDEX IF NOT EXISTS "idx_assignments_covering" ON "public"."assignments" USING "btree" ("id") INCLUDE ("title", "release_date", "due_date", "class_id");

ALTER POLICY "Assignees can view their own review assignments" ON "public"."review_assignments"
  USING (  (authorizeforprofile(assignee_profile_id) AND ((release_date IS NULL) OR (now() >= release_date))));

-- Add RLS policy to allow review assignment assignees to mark their assignments as completed
CREATE POLICY "Assignees can mark their review assignments as completed" 
ON "public"."review_assignments" 
FOR UPDATE 
TO "authenticated" 
USING (
    -- Must be the assignee of this review assignment
    "public"."authorizeforprofile"("assignee_profile_id")
    AND
    -- completed_at must currently be NULL (not already completed)
    "completed_at" IS NULL
) 
WITH CHECK (
    -- Must be the assignee of this review assignment  
    "public"."authorizeforprofile"("assignee_profile_id")
    AND
    -- completed_at must be set to non-NULL (marking as completed)
    "completed_at" IS NOT NULL
    AND
    -- completed_by must be set to the current user's profile
    "public"."authorizeforprofile"("completed_by")
);

-- View for review assignment summary by assignee
-- Provides summary information about review assignments grouped by assignment
-- for use in instructor/grader dashboards
CREATE OR REPLACE VIEW public.review_assignments_summary_by_assignee 
WITH (security_invoker='true') 
AS
SELECT 
  ra.assignee_profile_id,
  ra.assignment_id,
  ra.class_id,
  a.title as assignment_title,
  COUNT(*) as total_reviews,
  COUNT(ra.completed_at) as completed_reviews,
  COUNT(*) - COUNT(ra.completed_at) as incomplete_reviews,
  MIN(ra.due_date) as soonest_due_date,
  MIN(ra.release_date) as earliest_release_date
FROM review_assignments ra
INNER JOIN assignments a ON a.id = ra.assignment_id
WHERE 
  -- Only include review assignments that have been released
  (ra.release_date IS NULL OR ra.release_date <= now())
GROUP BY 
  ra.assignee_profile_id, 
  ra.assignment_id, 
  ra.class_id,
  a.title;
-- Index to optimize the view performance
CREATE INDEX IF NOT EXISTS "idx_review_assignments_assignee_assignment_released" 
ON "public"."review_assignments" 
USING "btree" ("assignee_profile_id", "assignment_id", "release_date", "completed_at");

-- Indexes to optimize the check_and_complete_submission_review() trigger function
-- Index on rubric_parts(rubric_id) to optimize the aggregate query counting total rubric parts
CREATE INDEX IF NOT EXISTS "idx_rubric_parts_rubric_id" 
ON "public"."rubric_parts" 
USING "btree" ("rubric_id");

-- Index on review_assignment_rubric_parts(review_assignment_id) to optimize the joins in the trigger
CREATE INDEX IF NOT EXISTS "idx_review_assignment_rubric_parts_review_assignment_id" 
ON "public"."review_assignment_rubric_parts" 
USING "btree" ("review_assignment_id");
