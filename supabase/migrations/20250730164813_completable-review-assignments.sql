-- Add completed_at column to review_assignments
alter table review_assignments add column completed_at timestamp with time zone;

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
    completing_user_id := NEW.assignee_profile_id;
    
    -- Get the rubric_id for this submission review
    select rubric_id into target_rubric_id
    from submission_reviews 
    where id = target_submission_review_id;
    
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

    return NEW;
end;
$$;

-- Create trigger on review_assignments table
create trigger trigger_check_and_complete_submission_review
    after update on review_assignments
    for each row
    execute function check_and_complete_submission_review();