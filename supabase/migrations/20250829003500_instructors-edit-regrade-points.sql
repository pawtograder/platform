-- Create a new RPC function that allows instructors to edit regrade request points
-- without changing the status, for cases where they need to correct TA decisions
-- or modify their own escalation decisions.

CREATE OR REPLACE FUNCTION "public"."update_regrade_request_points"(
    "regrade_request_id" bigint,
    "profile_id" "uuid",
    "resolved_points" integer DEFAULT NULL::integer,
    "closed_points" integer DEFAULT NULL::integer
) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    current_request record;
    param_resolved_points integer;
    param_closed_points integer;
begin
    param_resolved_points := resolved_points;
    param_closed_points := closed_points;
    
    -- Get the current regrade request
    select *
    into current_request
    from public.submission_regrade_requests
    where id = regrade_request_id;
    
    if not found then
        raise exception 'Regrade request not found';
    end if;
    
    -- Only instructors can edit points
    if not authorizeforprofile(profile_id) then
        raise exception 'Unauthorized to act as this profile';
    end if;
    if not authorizeforclassinstructor(current_request.class_id) then
        raise exception 'Only instructors can edit regrade request points';
    end if;
    
    -- Validate that we're only updating points for appropriate statuses
    if resolved_points is not null and current_request.status not in ('resolved', 'escalated', 'closed') then
        raise exception 'Can only update resolved_points for requests that have been resolved';
    end if;
    
    if closed_points is not null and current_request.status != 'closed' then
        raise exception 'Can only update closed_points for requests that have been closed';
    end if;
    
    -- Ensure at least one points parameter is provided
    if resolved_points is null and closed_points is null then
        raise exception 'Either resolved_points or closed_points must be provided';
    end if;
    
    -- Update the regrade request points
    if resolved_points is not null then
        update public.submission_regrade_requests
        set resolved_points = param_resolved_points,
            last_updated_at = now()
        where id = regrade_request_id;
        
        -- Update the original comment's points to match
        if current_request.submission_file_comment_id is not null then
            update public.submission_file_comments
            set points = param_resolved_points
            where id = current_request.submission_file_comment_id;
        elsif current_request.submission_comment_id is not null then
            update public.submission_comments
            set points = param_resolved_points
            where id = current_request.submission_comment_id;
        elsif current_request.submission_artifact_comment_id is not null then
            update public.submission_artifact_comments
            set points = param_resolved_points
            where id = current_request.submission_artifact_comment_id;
        end if;
    end if;
    
    if closed_points is not null then
        update public.submission_regrade_requests
        set closed_points = param_closed_points,
            last_updated_at = now()
        where id = regrade_request_id;
        
        -- Update the original comment's points to match the final decision
        if current_request.submission_file_comment_id is not null then
            update public.submission_file_comments
            set points = param_closed_points
            where id = current_request.submission_file_comment_id;
        elsif current_request.submission_comment_id is not null then
            update public.submission_comments
            set points = param_closed_points
            where id = current_request.submission_comment_id;
        elsif current_request.submission_artifact_comment_id is not null then
            update public.submission_artifact_comments
            set points = param_closed_points
            where id = current_request.submission_artifact_comment_id;
        end if;
    end if;
    
    return true;
end;
$$;

-- Grant permissions to the new function
GRANT ALL ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" "uuid", "resolved_points" integer, "closed_points" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" "uuid", "resolved_points" integer, "closed_points" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" "uuid", "resolved_points" integer, "closed_points" integer) TO "service_role";

-- Add a comment explaining the function's purpose
COMMENT ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" "uuid", "resolved_points" integer, "closed_points" integer) IS 'Allows instructors to edit resolved_points or closed_points on regrade requests without changing the status. Used for correcting TA decisions or modifying instructor escalation decisions.';
