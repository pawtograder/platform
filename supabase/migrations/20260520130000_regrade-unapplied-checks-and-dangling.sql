-- Regrade requests: support un-applied rubric checks (#457) and prevent dangling
-- requests when a graded comment is deleted/re-graded (#517).
--
-- 1. Schema: a regrade request can now target a bare rubric_check_id (no comment yet),
--    bound to a submission_review_id. resolution_reason records *why* a request resolved.
-- 2. Constraint relaxed: at most one comment FK, and a request must target either a
--    comment OR a rubric check.
-- 3. New RPC create_regrade_request_for_check for un-applied checks.
-- 4. update_regrade_request_status: resolving/closing a bare-check request now creates the
--    real submission_comment so the gradebook recompute picks up the points.
-- 5. Trigger: soft-deleting a comment that backs an open request auto-resolves the request
--    (resolution_reason = 'comment_deleted') instead of leaving it stuck "pending".

-- ---------------------------------------------------------------------------
-- 1. Schema additions
-- ---------------------------------------------------------------------------
alter table "public"."submission_regrade_requests"
    add column "rubric_check_id" bigint,
    add column "submission_review_id" bigint,
    add column "resolution_reason" text;

alter table "public"."submission_regrade_requests"
    add constraint "submission_regrade_requests_rubric_check_id_fkey"
        foreign key (rubric_check_id) references rubric_checks(id) not valid;
alter table "public"."submission_regrade_requests"
    validate constraint "submission_regrade_requests_rubric_check_id_fkey";

alter table "public"."submission_regrade_requests"
    add constraint "submission_regrade_requests_submission_review_id_fkey"
        foreign key (submission_review_id) references submission_reviews(id) not valid;
alter table "public"."submission_regrade_requests"
    validate constraint "submission_regrade_requests_submission_review_id_fkey";

create index if not exists submission_regrade_requests_rubric_check_id_idx
    on public.submission_regrade_requests using btree (rubric_check_id);
create index if not exists submission_regrade_requests_submission_review_id_idx
    on public.submission_regrade_requests using btree (submission_review_id);

-- Enforce at most one ACTIVE bare-check request per (review, check) at the DB level,
-- so a read-then-insert race in create_regrade_request_for_check cannot create
-- duplicate active requests. Comment-backed requests have a comment FK set and are
-- excluded; once a bare-check request is resolved it gets a comment FK and leaves
-- this partial index.
create unique index if not exists submission_regrade_requests_active_bare_check_uniq
    on public.submission_regrade_requests (submission_review_id, rubric_check_id)
    where submission_file_comment_id is null
      and submission_comment_id is null
      and submission_artifact_comment_id is null
      and status in ('draft', 'opened', 'escalated');

-- ---------------------------------------------------------------------------
-- 2. Backfill rubric_check_id + submission_review_id from existing comment-backed
--    requests so every request can be grouped/displayed uniformly.
-- ---------------------------------------------------------------------------
update public.submission_regrade_requests r
set rubric_check_id = c.rubric_check_id,
    submission_review_id = c.submission_review_id
from public.submission_file_comments c
where r.submission_file_comment_id = c.id
  and r.rubric_check_id is null;

update public.submission_regrade_requests r
set rubric_check_id = c.rubric_check_id,
    submission_review_id = c.submission_review_id
from public.submission_comments c
where r.submission_comment_id = c.id
  and r.rubric_check_id is null;

update public.submission_regrade_requests r
set rubric_check_id = c.rubric_check_id,
    submission_review_id = c.submission_review_id
from public.submission_artifact_comments c
where r.submission_artifact_comment_id = c.id
  and r.rubric_check_id is null;

-- ---------------------------------------------------------------------------
-- 3. Relax the "exactly one comment" constraint.
--    A request must reference at most one comment, and must target either a
--    comment or a bare rubric check.
-- ---------------------------------------------------------------------------
alter table "public"."submission_regrade_requests"
    drop constraint if exists "submission_regrade_requests_exactly_one_comment_check";

alter table "public"."submission_regrade_requests"
    add constraint "submission_regrade_requests_target_check" check (
        (
            (submission_file_comment_id is not null)::int +
            (submission_comment_id is not null)::int +
            (submission_artifact_comment_id is not null)::int
        ) <= 1
        and
        (
            submission_file_comment_id is not null
            or submission_comment_id is not null
            or submission_artifact_comment_id is not null
            or rubric_check_id is not null
        )
    );

-- ---------------------------------------------------------------------------
-- 4. New RPC: create a regrade request for a rubric check that was NOT applied (#457).
--    No comment exists yet; the request is bound to (submission_review_id, rubric_check_id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_regrade_request_for_check(
    private_profile_id uuid,
    p_submission_review_id bigint,
    p_rubric_check_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    review_submission_id bigint;
    review_class_id bigint;
    review_rubric_id bigint;
    review_grader uuid;
    review_assignment_id bigint;
    check_rubric_id bigint;
    assignment_regrade_deadline timestamptz;
    existing_request_id bigint;
    new_regrade_request_id bigint;
begin
    -- Resolve the review and its submission/assignment context.
    select sr.submission_id, sr.class_id, sr.rubric_id, sr.grader, s.assignment_id
    into review_submission_id, review_class_id, review_rubric_id, review_grader, review_assignment_id
    from public.submission_reviews sr
    inner join public.submissions s on s.id = sr.submission_id
    where sr.id = p_submission_review_id;

    if not found then
        raise exception 'Submission review not found';
    end if;

    -- The rubric check must belong to the same rubric as the review.
    select rcr.rubric_id
    into check_rubric_id
    from public.rubric_checks rc
    inner join public.rubric_criteria rcr on rcr.id = rc.rubric_criteria_id
    where rc.id = p_rubric_check_id;

    if not found then
        raise exception 'Rubric check not found';
    end if;

    if check_rubric_id is distinct from review_rubric_id then
        raise exception 'Rubric check does not belong to this review''s rubric';
    end if;

    -- Authorization: caller must be able to act on this submission and as this profile.
    if not public.authorize_for_submission(review_submission_id) then
        raise exception 'Unauthorized access to submission';
    end if;

    if not public.authorizeforprofile(private_profile_id) then
        raise exception 'Unauthorized access to profile';
    end if;

    -- Enforce the regrade deadline if one is set.
    select a.regrade_deadline
    into assignment_regrade_deadline
    from public.assignments a
    where a.id = review_assignment_id;

    if assignment_regrade_deadline is not null and now() > assignment_regrade_deadline then
        raise exception 'The regrade request deadline has passed. Regrade requests were due by %.',
            to_char(assignment_regrade_deadline, 'Mon DD, YYYY at HH12:MI AM TZ');
    end if;

    -- Reject if the check is actually already applied (a live grading comment exists).
    -- Those disputes should go through the comment-based regrade flow instead.
    if exists (
        select 1 from public.submission_comments
        where submission_review_id = p_submission_review_id and rubric_check_id = p_rubric_check_id and deleted_at is null
        union all
        select 1 from public.submission_file_comments
        where submission_review_id = p_submission_review_id and rubric_check_id = p_rubric_check_id and deleted_at is null
        union all
        select 1 from public.submission_artifact_comments
        where submission_review_id = p_submission_review_id and rubric_check_id = p_rubric_check_id and deleted_at is null
    ) then
        raise exception 'This rubric check is already applied; request a regrade on the existing grade instead';
    end if;

    -- Prevent duplicate open requests for the same un-applied check on this review.
    -- (The partial unique index submission_regrade_requests_active_bare_check_uniq is the
    -- atomic backstop; this check just produces a friendlier error in the common case.)
    select id
    into existing_request_id
    from public.submission_regrade_requests
    where submission_review_id = p_submission_review_id
      and rubric_check_id = p_rubric_check_id
      and submission_file_comment_id is null
      and submission_comment_id is null
      and submission_artifact_comment_id is null
      and status in ('draft', 'opened', 'escalated')
    limit 1;

    if existing_request_id is not null then
        raise exception 'An open regrade request already exists for this rubric check';
    end if;

    insert into public.submission_regrade_requests (
        submission_id,
        class_id,
        assignment_id,
        created_by,
        assignee,
        status,
        rubric_check_id,
        submission_review_id,
        initial_points
    ) values (
        review_submission_id,
        review_class_id,
        review_assignment_id,
        private_profile_id,
        coalesce(review_grader, private_profile_id),
        'draft',
        p_rubric_check_id,
        p_submission_review_id,
        0
    ) returning id into new_regrade_request_id;

    return new_regrade_request_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Helper: materialize the backing comment for a bare-check regrade request.
--    Creates submission_comments, submission_file_comments, or submission_artifact_comments
--    depending on the rubric check's annotation configuration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._materialize_bare_check_regrade_comment(
    p_request public.submission_regrade_requests,
    p_author uuid,
    p_points numeric,
    p_regrade_request_id bigint,
    p_submission_file_id bigint,
    p_line integer,
    p_submission_artifact_id bigint,
    OUT o_submission_comment_id bigint,
    OUT o_submission_file_comment_id bigint,
    OUT o_submission_artifact_comment_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    v_check record;
    v_target_student_profile_id uuid;
    v_comment_text constant text := 'Added via regrade request for a rubric check that was not originally applied.';
    v_file_name text;
    v_artifact_name text;
begin
    o_submission_comment_id := null;
    o_submission_file_comment_id := null;
    o_submission_artifact_comment_id := null;

    select rc.id, rc.is_annotation, rc.annotation_target, rc.file, rc.artifact,
           rp.is_individual_grading
    into v_check
    from public.rubric_checks rc
    inner join public.rubric_criteria rcr on rcr.id = rc.rubric_criteria_id
    inner join public.rubric_parts rp on rp.id = rcr.rubric_part_id
    where rc.id = p_request.rubric_check_id;

    if not found then
        raise exception 'Rubric check not found for bare-check regrade request';
    end if;

    v_target_student_profile_id := case
        when v_check.is_individual_grading then p_request.created_by
        else null
    end;

    if v_check.is_annotation and coalesce(v_check.annotation_target, 'file') = 'artifact' then
        if p_submission_artifact_id is null then
            raise exception 'submission_artifact_id is required to resolve this rubric check regrade request';
        end if;

        select sa.name
        into v_artifact_name
        from public.submission_artifacts sa
        where sa.id = p_submission_artifact_id
          and sa.submission_id = p_request.submission_id;

        if not found then
            raise exception 'Artifact does not belong to this submission';
        end if;

        if v_check.artifact is not null and v_check.artifact is distinct from v_artifact_name then
            raise exception 'Artifact must match rubric check artifact %', v_check.artifact;
        end if;

        insert into public.submission_artifact_comments (
            submission_id,
            submission_artifact_id,
            author,
            comment,
            points,
            class_id,
            rubric_check_id,
            submission_review_id,
            released,
            regrade_request_id,
            target_student_profile_id
        ) values (
            p_request.submission_id,
            p_submission_artifact_id,
            p_author,
            v_comment_text,
            p_points,
            p_request.class_id,
            p_request.rubric_check_id,
            p_request.submission_review_id,
            true,
            p_regrade_request_id,
            v_target_student_profile_id
        ) returning id into o_submission_artifact_comment_id;

    elsif v_check.is_annotation then
        if p_submission_file_id is null or p_line is null then
            raise exception 'submission_file_id and line are required to resolve this rubric check regrade request';
        end if;

        if p_line < 1 then
            raise exception 'line must be a positive integer';
        end if;

        select sf.name
        into v_file_name
        from public.submission_files sf
        where sf.id = p_submission_file_id
          and sf.submission_id = p_request.submission_id;

        if not found then
            raise exception 'File does not belong to this submission';
        end if;

        if v_check.file is not null and v_check.file is distinct from v_file_name then
            raise exception 'File must match rubric check file %', v_check.file;
        end if;

        insert into public.submission_file_comments (
            submission_id,
            submission_file_id,
            author,
            comment,
            line,
            points,
            class_id,
            rubric_check_id,
            submission_review_id,
            released,
            regrade_request_id,
            target_student_profile_id
        ) values (
            p_request.submission_id,
            p_submission_file_id,
            p_author,
            v_comment_text,
            p_line,
            p_points,
            p_request.class_id,
            p_request.rubric_check_id,
            p_request.submission_review_id,
            true,
            p_regrade_request_id,
            v_target_student_profile_id
        ) returning id into o_submission_file_comment_id;

    else
        if p_submission_file_id is not null or p_line is not null or p_submission_artifact_id is not null then
            raise exception 'Global rubric checks do not accept file or artifact location parameters';
        end if;

        insert into public.submission_comments (
            submission_id,
            author,
            comment,
            points,
            class_id,
            rubric_check_id,
            submission_review_id,
            released,
            regrade_request_id,
            target_student_profile_id
        ) values (
            p_request.submission_id,
            p_author,
            v_comment_text,
            p_points,
            p_request.class_id,
            p_request.rubric_check_id,
            p_request.submission_review_id,
            true,
            p_regrade_request_id,
            v_target_student_profile_id
        ) returning id into o_submission_comment_id;
    end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Update update_regrade_request_status so that resolving/closing a bare-check
--    request (no comment yet) creates the real submission_comment, then proceeds
--    exactly as the comment-backed path. Otherwise unchanged from the prior version.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_regrade_request_status(
    regrade_request_id bigint,
    new_status regrade_status,
    profile_id uuid,
    resolved_points numeric DEFAULT NULL,
    closed_points numeric DEFAULT NULL,
    p_submission_file_id bigint DEFAULT NULL,
    p_line integer DEFAULT NULL,
    p_submission_artifact_id bigint DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    current_request public.submission_regrade_requests%ROWTYPE;
    param_resolved_points numeric;
    param_closed_points numeric;
    new_submission_comment_id bigint;
    new_submission_file_comment_id bigint;
    new_submission_artifact_comment_id bigint;
    is_bare_check boolean;
begin
    param_resolved_points := resolved_points;
    param_closed_points := closed_points;

    -- Lock the request row so two concurrent transitions cannot both observe the same
    -- pre-transition state and (for bare-check requests) both materialize a backing
    -- comment, which would double-count points in grade recomputation.
    select *
    into current_request
    from public.submission_regrade_requests
    where id = regrade_request_id
    for update;

    if not found then
        raise exception 'Regrade request not found';
    end if;

    if new_status = 'resolved' and resolved_points is null then
        raise exception 'resolved_points parameter is required when status is resolved';
    end if;

    if new_status = 'closed' and closed_points is null then
        raise exception 'closed_points parameter is required when status is closed';
    end if;

    -- A "bare check" request targets a rubric check but has no comment yet.
    is_bare_check := current_request.submission_file_comment_id is null
        and current_request.submission_comment_id is null
        and current_request.submission_artifact_comment_id is null
        and current_request.rubric_check_id is not null;

    case new_status
        when 'opened' then
            if current_request.status != 'draft' then
                raise exception 'Can only open regrade requests that are in draft status';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can open regrade requests';
            end if;

            update public.submission_regrade_requests
            set status = new_status,
                opened_at = now(),
                last_updated_at = now()
            where id = regrade_request_id;

            -- Notify the assignee. For comment-backed requests the assignee is the comment
            -- author; for bare-check requests it is the review's grader (stored on creation).
            insert into public.notifications (class_id, subject, body, style, user_id)
            select
                distinct on (ur.user_id)
                current_request.class_id,
                '{}'::jsonb as subject,
                jsonb_build_object(
                    'type', 'regrade_request',
                    'action', 'comment_challenged',
                    'regrade_request_id', regrade_request_id,
                    'submission_id', current_request.submission_id,
                    'assignment_id', current_request.assignment_id,
                    'opened_by', profile_id,
                    'opened_by_name', (select name from public.profiles where id = profile_id)
                ) as body,
                'info' as style,
                ur.user_id
            from public.user_roles ur
            where ur.class_id = current_request.class_id
              and ur.private_profile_id = (
                case
                    when current_request.submission_file_comment_id is not null then
                        (select author from public.submission_file_comments where id = current_request.submission_file_comment_id)
                    when current_request.submission_comment_id is not null then
                        (select author from public.submission_comments where id = current_request.submission_comment_id)
                    when current_request.submission_artifact_comment_id is not null then
                        (select author from public.submission_artifact_comments where id = current_request.submission_artifact_comment_id)
                    else current_request.assignee
                end
              );

        when 'resolved' then
            if current_request.status != 'opened' then
                raise exception 'Can only resolve regrade requests that are opened';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Unauthorized to act as this profile';
            end if;
            if not authorizeforclassgrader(current_request.class_id) then
                raise exception 'Only graders can resolve regrade requests';
            end if;

            -- For a bare-check request, materialize the real comment now so the score
            -- recompute (which sums comment points by rubric_check_id) picks it up.
            if is_bare_check then
                select
                    m.o_submission_comment_id,
                    m.o_submission_file_comment_id,
                    m.o_submission_artifact_comment_id
                into
                    new_submission_comment_id,
                    new_submission_file_comment_id,
                    new_submission_artifact_comment_id
                from public._materialize_bare_check_regrade_comment(
                    current_request,
                    profile_id,
                    param_resolved_points,
                    regrade_request_id,
                    p_submission_file_id,
                    p_line,
                    p_submission_artifact_id
                ) as m;

                update public.submission_regrade_requests
                set status = new_status,
                    resolved_by = profile_id,
                    resolved_at = now(),
                    resolved_points = param_resolved_points,
                    submission_comment_id = new_submission_comment_id,
                    submission_file_comment_id = new_submission_file_comment_id,
                    submission_artifact_comment_id = new_submission_artifact_comment_id,
                    resolution_reason = 'grader',
                    last_updated_at = now()
                where id = regrade_request_id;
            else
                update public.submission_regrade_requests
                set status = new_status,
                    resolved_by = profile_id,
                    resolved_at = now(),
                    resolved_points = param_resolved_points,
                    resolution_reason = 'grader',
                    last_updated_at = now()
                where id = regrade_request_id;

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

        when 'escalated' then
            if current_request.status != 'resolved' then
                raise exception 'Can only escalate regrade requests that are resolved';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can escalate regrade requests';
            end if;

            update public.submission_regrade_requests
            set status = new_status,
                escalated_by = profile_id,
                escalated_at = now(),
                last_updated_at = now()
            where id = regrade_request_id;

        when 'closed' then
            if current_request.status not in ('resolved', 'escalated', 'opened') then
                raise exception 'Can only close regrade requests that are resolved, escalated, or opened';
            end if;
            if not public.authorizeforprofile(profile_id) then
                raise exception 'Unauthorized to act as this profile';
            end if;
            if not public.authorizeforclassinstructor(current_request.class_id) then
                raise exception 'Only instructors can close regrade requests';
            end if;

            -- A bare-check request can be closed directly from 'opened' without a grader
            -- having resolved it; materialize the comment in that case too.
            if is_bare_check and current_request.submission_comment_id is null
               and current_request.submission_file_comment_id is null
               and current_request.submission_artifact_comment_id is null then
                select
                    m.o_submission_comment_id,
                    m.o_submission_file_comment_id,
                    m.o_submission_artifact_comment_id
                into
                    new_submission_comment_id,
                    new_submission_file_comment_id,
                    new_submission_artifact_comment_id
                from public._materialize_bare_check_regrade_comment(
                    current_request,
                    profile_id,
                    param_closed_points,
                    regrade_request_id,
                    p_submission_file_id,
                    p_line,
                    p_submission_artifact_id
                ) as m;

                update public.submission_regrade_requests
                set status = new_status,
                    closed_by = profile_id,
                    closed_at = now(),
                    closed_points = param_closed_points,
                    submission_comment_id = new_submission_comment_id,
                    submission_file_comment_id = new_submission_file_comment_id,
                    submission_artifact_comment_id = new_submission_artifact_comment_id,
                    resolution_reason = 'instructor',
                    last_updated_at = now()
                where id = regrade_request_id;
            else
                update public.submission_regrade_requests
                set status = new_status,
                    closed_by = profile_id,
                    closed_at = now(),
                    closed_points = param_closed_points,
                    resolution_reason = 'instructor',
                    last_updated_at = now()
                where id = regrade_request_id;

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

        when 'draft' then
            raise exception 'Cannot transition back to draft status';

        else
            raise exception 'Invalid status: %', new_status;
    end case;

    -- Notify all students connected to the submission of the status change.
    insert into public.notifications (class_id, subject, body, style, user_id)
    select
        current_request.class_id,
        '{}'::jsonb as subject,
        jsonb_build_object(
            'type', 'regrade_request',
            'action', 'status_change',
            'regrade_request_id', regrade_request_id,
            'old_status', current_request.status,
            'new_status', new_status,
            'submission_id', current_request.submission_id,
            'assignment_id', current_request.assignment_id,
            'updated_by', profile_id,
            'updated_by_name', (select name from public.profiles where id = profile_id)
        ) as body,
        'info' as style,
        ur.user_id
    from public.user_roles ur
    where ur.class_id = current_request.class_id
      and ur.role = 'student'
      and ur.private_profile_id != profile_id
      and ur.private_profile_id in (
        select s.profile_id
        from public.submissions s
        where s.id = current_request.submission_id

        union

        select agm.profile_id
        from public.submissions s
        inner join public.assignment_groups_members agm
            on agm.assignment_group_id = s.assignment_group_id
        where s.id = current_request.submission_id
          and s.assignment_group_id is not null
      );

    if new_status = 'escalated' then
        insert into public.notifications (class_id, subject, body, style, user_id)
        select
            current_request.class_id,
            '{}'::jsonb as subject,
            jsonb_build_object(
                'type', 'regrade_request',
                'action', 'escalated',
                'regrade_request_id', regrade_request_id,
                'old_status', current_request.status,
                'new_status', new_status,
                'submission_id', current_request.submission_id,
                'assignment_id', current_request.assignment_id,
                'escalated_by', profile_id,
                'escalated_by_name', (select name from public.profiles where id = profile_id)
            ) as body,
            'warning' as style,
            ur.user_id
        from public.user_roles ur
        where ur.class_id = current_request.class_id
          and ur.role = 'instructor';
    end if;

    return true;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Auto-resolve dangling requests (#517).
--    When a graded comment that backs an open regrade request is soft-deleted
--    (deleted_at set, e.g. a TA deletes and re-grades), the request would otherwise
--    be stuck "pending" with no UI surface. Auto-resolve it so it stops being
--    actionable as pending. This is NOT terminal: the student can still escalate
--    a 'resolved' request to an instructor if they disagree.
--
--    Notifies the student(s) on the submission so they know to re-check the grade and
--    escalate if they still disagree. The notification insert is wrapped so a failure
--    can never roll back the grader's legitimate delete/re-grade workflow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_resolve_regrade_on_comment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    affected record;
begin
    if NEW.regrade_request_id is not null
       and OLD.deleted_at is null
       and NEW.deleted_at is not null then
        -- Only auto-resolve requests that have NOT yet reached an instructor. An
        -- 'escalated' request is in the instructor queue awaiting final review; deleting
        -- the backing comment must not silently pull it back out of that queue.
        update public.submission_regrade_requests
        set status = 'resolved',
            resolved_by = coalesce(NEW.edited_by, assignee),
            resolved_at = now(),
            resolved_points = initial_points,
            resolution_reason = 'comment_deleted',
            last_updated_at = now()
        where id = NEW.regrade_request_id
          and status in ('draft', 'opened')
        returning class_id, submission_id, assignment_id, resolved_by
        into affected;

        -- Notify the submission's student(s). Best-effort: a notification failure must
        -- never abort the comment soft-delete that triggered this.
        if found then
            begin
                insert into public.notifications (class_id, subject, body, style, user_id)
                select
                    affected.class_id,
                    '{}'::jsonb as subject,
                    jsonb_build_object(
                        'type', 'regrade_request',
                        'action', 'auto_resolved',
                        'regrade_request_id', NEW.regrade_request_id,
                        'submission_id', affected.submission_id,
                        'assignment_id', affected.assignment_id,
                        'resolution_reason', 'comment_deleted',
                        'resolved_by', affected.resolved_by,
                        'resolved_by_name', (select name from public.profiles where id = affected.resolved_by)
                    ) as body,
                    'info' as style,
                    ur.user_id
                from public.user_roles ur
                where ur.class_id = affected.class_id
                  and ur.role = 'student'
                  and ur.private_profile_id in (
                    select s.profile_id
                    from public.submissions s
                    where s.id = affected.submission_id

                    union

                    select agm.profile_id
                    from public.submissions s
                    inner join public.assignment_groups_members agm
                        on agm.assignment_group_id = s.assignment_group_id
                    where s.id = affected.submission_id
                      and s.assignment_group_id is not null
                  );
            exception when others then
                -- Non-critical: swallow so the grader's delete/re-grade still succeeds.
                null;
            end;
        end if;
    end if;
    return NEW;
end;
$function$;

create trigger auto_resolve_regrade_on_file_comment_delete
    after update of deleted_at on public.submission_file_comments
    for each row execute function public.auto_resolve_regrade_on_comment_delete();

create trigger auto_resolve_regrade_on_comment_delete
    after update of deleted_at on public.submission_comments
    for each row execute function public.auto_resolve_regrade_on_comment_delete();

create trigger auto_resolve_regrade_on_artifact_comment_delete
    after update of deleted_at on public.submission_artifact_comments
    for each row execute function public.auto_resolve_regrade_on_comment_delete();

grant execute on function public.create_regrade_request_for_check(uuid, bigint, bigint) to authenticated;
grant execute on function public._materialize_bare_check_regrade_comment(
    public.submission_regrade_requests,
    uuid,
    numeric,
    bigint,
    bigint,
    integer,
    bigint
) to authenticated;
