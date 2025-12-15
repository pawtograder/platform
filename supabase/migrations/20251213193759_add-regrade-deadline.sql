-- Add regrade_deadline column to assignments table
-- This column specifies the deadline after which students cannot submit new regrade requests.
-- If NULL, regrade requests are always allowed (backward compatibility).

ALTER TABLE "public"."assignments" 
ADD COLUMN "regrade_deadline" timestamp with time zone;

-- Add a comment to document the column
COMMENT ON COLUMN "public"."assignments"."regrade_deadline" IS 
'The deadline after which regrade requests cannot be submitted. NULL means no deadline (always allowed).';

-- Update the create_regrade_request function to check the deadline
CREATE OR REPLACE FUNCTION public.create_regrade_request(
    private_profile_id uuid,
    submission_file_comment_id bigint DEFAULT NULL,
    submission_comment_id bigint DEFAULT NULL,
    submission_artifact_comment_id bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    comment_submission_id bigint;
    comment_submission_review_id bigint;
    comment_class_id bigint;
    comment_assignment_id bigint;
    comment_author_id uuid;
    comment_points integer;
    comment_regrade_request_id bigint;
    param_count int;
    new_regrade_request_id bigint;
    grading_rubric_id bigint;
    assignment_regrade_deadline timestamptz;
begin
    -- Count how many non-null parameters were provided
    param_count := 0;
    if submission_file_comment_id is not null then
        param_count := param_count + 1;
    end if;
    if submission_comment_id is not null then
        param_count := param_count + 1;
    end if;
    if submission_artifact_comment_id is not null then
        param_count := param_count + 1;
    end if;
    
    -- Exactly one parameter must be provided
    if param_count != 1 then
        raise exception 'Exactly one comment ID must be provided';
    end if;
    
    -- Get submission info based on which comment type was provided
    if submission_file_comment_id is not null then
        select sfc.submission_id, sfc.submission_review_id, sfc.class_id, sfc.author, s.assignment_id, sfc.points, sfc.regrade_request_id
        into comment_submission_id, comment_submission_review_id, comment_class_id, comment_author_id, comment_assignment_id, comment_points, comment_regrade_request_id
        from public.submission_file_comments sfc
        inner join public.submissions s on s.id = sfc.submission_id
        where sfc.id = submission_file_comment_id;

        if not found then
            raise exception 'Submission file comment not found';
        end if;

        if comment_regrade_request_id is not null then
            raise exception 'A regrade request already exists for this comment';
        end if;
    elsif submission_comment_id is not null then
        select sc.submission_id, sc.submission_review_id, sc.class_id, sc.author, s.assignment_id, sc.points, sc.regrade_request_id
        into comment_submission_id, comment_submission_review_id, comment_class_id, comment_author_id, comment_assignment_id, comment_points, comment_regrade_request_id
        from public.submission_comments sc
        inner join public.submissions s on s.id = sc.submission_id
        where sc.id = submission_comment_id;

        if not found then
            raise exception 'Submission comment not found';
        end if;

        if comment_regrade_request_id is not null then
            raise exception 'A regrade request already exists for this comment';
        end if;
    elsif submission_artifact_comment_id is not null then
        select sac.submission_id, sac.submission_review_id, sac.class_id, sac.author, s.assignment_id, sac.points, sac.regrade_request_id
        into comment_submission_id, comment_submission_review_id, comment_class_id, comment_author_id, comment_assignment_id, comment_points, comment_regrade_request_id
        from public.submission_artifact_comments sac
        inner join public.submissions s on s.id = sac.submission_id
        where sac.id = submission_artifact_comment_id;

        if not found then
            raise exception 'Submission artifact comment not found';
        end if;

        if comment_regrade_request_id is not null then
            raise exception 'A regrade request already exists for this comment';
        end if;
    end if;
    
    -- Check authorization for the submission
    if not public.authorize_for_submission(comment_submission_id) then
        raise exception 'Unauthorized access to submission';
    end if;

    if not public.authorizeforprofile(private_profile_id) then
        raise exception 'Unauthorized access to profile';
    end if;
    
    -- Check if regrade deadline has passed
    select a.regrade_deadline
    into assignment_regrade_deadline
    from public.assignments a
    where a.id = comment_assignment_id;
    
    -- If regrade_deadline is set (not null), check if we're past the deadline
    if assignment_regrade_deadline is not null then
        if now() > assignment_regrade_deadline then
            raise exception 'The regrade request deadline has passed. Regrade requests were due by %.', 
                to_char(assignment_regrade_deadline, 'Mon DD, YYYY at HH12:MI AM TZ');
        end if;
    end if;
    
    -- Create the regrade request
    insert into public.submission_regrade_requests (
        submission_id,
        class_id,
        assignment_id,
        created_by,
        assignee,
        status,
        submission_file_comment_id,
        submission_comment_id,
        submission_artifact_comment_id,
        initial_points
    ) values (
        comment_submission_id,
        comment_class_id,
        comment_assignment_id,
        private_profile_id,
        comment_author_id,
        'draft',
        submission_file_comment_id,
        submission_comment_id,
        submission_artifact_comment_id,
        comment_points
    ) returning id into new_regrade_request_id;
    
    -- Update the comment with the regrade request ID
    if submission_file_comment_id is not null then
        update public.submission_file_comments
        set regrade_request_id = new_regrade_request_id
        where id = submission_file_comment_id;
    elsif submission_comment_id is not null then
        update public.submission_comments
        set regrade_request_id = new_regrade_request_id
        where id = submission_comment_id;
    elsif submission_artifact_comment_id is not null then
        update public.submission_artifact_comments
        set regrade_request_id = new_regrade_request_id
        where id = submission_artifact_comment_id;
    end if;
    
    return new_regrade_request_id;
end;
$function$;
