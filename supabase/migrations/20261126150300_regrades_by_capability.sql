-- #1010: handling regrade requests follows the handle_regrades capability.
--
-- Why: resolving a regrade request and commenting on one as staff were decided by "is this user a
-- grader or instructor in the class" (authorizeforclassgrader). An instructor had no way to keep a
-- course coordinator, or any other custom role, out of the regrade queue while letting other
-- graders work it. Now one capability decides, in the database and on the screen.
--
-- What:
--   1. New capability handle_regrades. Every grader and instructor can resolve regrade requests
--      today, so it goes on the default instructor role, the default grader role and every existing
--      custom role (a custom role is a copy of the grader role made earlier, so it wouldn't pick up
--      a capability added to the grader role now). seed_default_class_roles() puts it on the default
--      grader role of new classes.
--   2. update_regrade_request_status: resolving checks handle_regrades in the request's own class
--      instead of authorizeforclassgrader, and a refusal raises 42501 (insufficient_privilege). The
--      body is the one from 20261125120000_rubric_check_delete_workflow.sql (#1432) with only that
--      check changed. Opening and escalating (the student's side) are unchanged. Closing an
--      escalated request stays instructor-only (authorizeforclassinstructor), as does
--      update_regrade_request_points, which this migration doesn't touch.
--   3. Commenting on a regrade request: staff need handle_regrades in the comment's class instead of
--      authorizeforclassgrader. Students still comment on open requests for their own submission
--      through authorize_for_submission_regrade_comment.
--   4. Three holes in the same policies are closed:
--      - The regrade request SELECT policy's staff branch compared ur.class_id to itself, so a grader
--        or instructor of any class could read every class's regrade requests. It now checks the
--        request's own class. Every grader and instructor of that class can still read them, with or
--        without handle_regrades, so a grader still sees a dispute on a submission they graded.
--      - The comment INSERT policy checked the class the new row named, not the request's class, so
--        a grader in one class could file a comment under another class's request. A comment's
--        class, submission and assignment must now match its request's. The app already copies all
--        three from the request.
--      - The same policy never checked the author, so a student on the submission could post a
--        comment that showed a TA's name. The author must now be the caller's own private or
--        public profile in the comment's class.
--
-- Who gains or loses: instructors, default graders and existing custom roles hold handle_regrades,
-- so nothing changes for them, except that staff of one class no longer read another class's
-- regrade requests. A custom role an instructor turns handle_regrades off for loses Resolve and
-- staff comments. Students and admins hold nothing new.
--
-- Not changed: creating and opening requests (create_regrade_request, create_regrade_request_for_check),
-- escalating, closing, editing points, the comment SELECT policy, notifications and Discord posts.
--
-- seed_default_class_roles() is re-created in full with the same body as
-- 20261126150200_grading_and_release_by_capability.sql. Its grader list is the one every #1010
-- migration that redefines it writes (moderate_discussion, grade_submissions, handle_regrades,
-- grant_extensions, help_students, manage_flashcards, run_polls); only the names that are
-- capabilities yet join.
--
-- Number: this was 20261122150100 until 2026-11-23, then 20261123040100, and then 20261123180100,
-- each time right after #1408's migration (20261122150000, 20261123040000, then 20261123180000).
-- On 2026-11-24 #1299 and #1300 put 20261124130000 and 20261124130100 on staging, and #1408's moved
-- to 20261124150200 and this one to 20261124150300. On 2026-11-25 #1297 put its own
-- 20261124150200 on staging and #1432 and #1433 put 20261125120000 and 20261125120100 there, so
-- #1408's moved to 20261126150200, after every migration on staging and in every open PR (the
-- newest is #1434's 20261126120000). This one stays right after #1408's and before #1410's
-- (20261126150400), so it also runs after #1299's, #1300's, #1301's and #1429's migrations, which
-- redefine seed_default_class_roles() too, and after #1432's, which redefines
-- update_regrade_request_status.
--
-- Safe to run again: the inserts skip rows that exist, CREATE OR REPLACE gives the same functions,
-- and each policy is dropped first.

-- ---------------------------------------------------------------------------
-- 1. The capability, on the default instructor and grader roles and on every custom role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('handle_regrades', 'Resolve regrade requests and comment on any regrade request')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'handle_regrades'
FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

-- The same function as 20261126150200_grading_and_release_by_capability.sql: the grader list there
-- already names handle_regrades, which joins now that it exists. Instructors get it from the
-- CROSS JOIN.
CREATE OR REPLACE FUNCTION public.seed_default_class_roles(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.class_roles (class_id, name, default_for)
  VALUES
    (p_class_id, 'instructor', 'instructor'),
    (p_class_id, 'grader', 'grader'),
    (p_class_id, 'student', 'student'),
    (p_class_id, 'admin', 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  CROSS JOIN public.capabilities c
  WHERE cr.class_id = p_class_id AND cr.default_for = 'instructor'
  ON CONFLICT DO NOTHING;

  -- What the default grader role can do today, for new classes (#1010). One list for every #1010
  -- migration that redefines this function, so whichever runs last keeps the others' grants. A
  -- name joins only once its capability exists, so the list can name capabilities other open PRs
  -- add (grade_submissions, handle_regrades and grant_extensions are #1408-#1410's,
  -- moderate_discussion is #1429's and help_students is #1301's). Each of those PRs also gives
  -- its capability to existing grader roles.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  JOIN public.capabilities c ON c.name IN (
    'moderate_discussion', 'grade_submissions', 'handle_regrades', 'grant_extensions',
    'help_students', 'manage_flashcards', 'run_polls'
  )
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. update_regrade_request_status: resolving needs handle_regrades
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_regrade_request_status(
    regrade_request_id bigint,
    new_status regrade_status,
    profile_id uuid,
    resolved_points numeric DEFAULT NULL::numeric,
    closed_points numeric DEFAULT NULL::numeric,
    p_submission_file_id bigint DEFAULT NULL::bigint,
    p_line integer DEFAULT NULL::integer,
    p_submission_artifact_id bigint DEFAULT NULL::bigint
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
    has_live_comment_target boolean;
    is_detached_target boolean;
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

    -- The acting profile must belong to an active member of the request's class. Graders in
    -- pseudonymous mode act with their public profile, so accept either.
    if not exists (
        select 1
        from public.user_roles ur
        where ur.class_id = current_request.class_id
          and (ur.private_profile_id = update_regrade_request_status.profile_id
               or ur.public_profile_id = update_regrade_request_status.profile_id)
          and ur.disabled = false
    ) then
        raise exception 'Profile is not enrolled in this class';
    end if;

    -- A "bare check" request targets a rubric check but has no comment yet.
    is_bare_check := current_request.submission_file_comment_id is null
        and current_request.submission_comment_id is null
        and current_request.submission_artifact_comment_id is null
        and current_request.rubric_check_id is not null;

    has_live_comment_target := (
        (current_request.submission_file_comment_id is not null and exists (
            select 1 from public.submission_file_comments
            where id = current_request.submission_file_comment_id and deleted_at is null
        ))
        or (current_request.submission_comment_id is not null and exists (
            select 1 from public.submission_comments
            where id = current_request.submission_comment_id and deleted_at is null
        ))
        or (current_request.submission_artifact_comment_id is not null and exists (
            select 1 from public.submission_artifact_comments
            where id = current_request.submission_artifact_comment_id and deleted_at is null
        ))
    );

    -- Detached requests have neither a live backing comment nor a live rubric_check_id to materialize.
    is_detached_target := not is_bare_check and not has_live_comment_target;

    if new_status = 'resolved' and resolved_points is null and not is_detached_target then
        raise exception 'resolved_points parameter is required when status is resolved';
    end if;

    if new_status = 'closed' and closed_points is null and not is_detached_target then
        raise exception 'closed_points parameter is required when status is closed';
    end if;

    case new_status
        when 'opened' then
            if current_request.status != 'draft' then
                raise exception 'Can only open regrade requests that are in draft status';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can open regrade requests';
            end if;
            if not exists (
                select 1
                from public.submissions s
                where s.id = current_request.submission_id
                  and (
                    s.profile_id = update_regrade_request_status.profile_id
                    or exists (
                        select 1
                        from public.assignment_groups_members agm
                        where agm.assignment_group_id = s.assignment_group_id
                          and agm.profile_id = update_regrade_request_status.profile_id
                    )
                  )
            ) then
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
            -- #1010: handle_regrades in the request's own class (loaded above, not passed in).
            if current_request.class_id not in (select public.user_class_ids_with_capability('handle_regrades')) then
                raise exception 'Only staff who handle regrade requests can resolve them'
                    using errcode = 'insufficient_privilege';
            end if;

            if is_detached_target then
                if param_resolved_points is not null then
                    raise exception 'Cannot set points on a regrade request whose rubric check or grading comment was deleted. Apply a replacement rubric check or grading comment on the submission, then resolve this request without a point adjustment.'
                        using errcode = 'invalid_parameter_value';
                end if;

                update public.submission_regrade_requests
                set status = new_status,
                    resolved_by = profile_id,
                    resolved_at = now(),
                    resolved_points = NULL,
                    resolution_reason = 'grader',
                    last_updated_at = now()
                where id = regrade_request_id;
            elsif is_bare_check then
                -- For a bare-check request, materialize the real comment now so the score
                -- recompute (which sums comment points by rubric_check_id) picks it up.
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
            if not exists (
                select 1
                from public.submissions s
                where s.id = current_request.submission_id
                  and (
                    s.profile_id = update_regrade_request_status.profile_id
                    or exists (
                        select 1
                        from public.assignment_groups_members agm
                        where agm.assignment_group_id = s.assignment_group_id
                          and agm.profile_id = update_regrade_request_status.profile_id
                    )
                  )
            ) then
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

            if is_detached_target then
                -- Detached requests have no live comment or rubric check to update/materialize, so
                -- silently recording a closed_points value would mislead the instructor into
                -- thinking the student's grade changed. Reject numeric point values and require
                -- replacement grading on the submission before closing without a point adjustment.
                if param_closed_points is not null then
                    raise exception 'Cannot set points on a regrade request whose rubric check or grading comment was deleted. Apply a replacement rubric check or grading comment on the submission, then close this request without a point adjustment.'
                        using errcode = 'invalid_parameter_value';
                end if;

                update public.submission_regrade_requests
                set status = new_status,
                    closed_by = profile_id,
                    closed_at = now(),
                    closed_points = NULL,
                    resolution_reason = 'instructor',
                    last_updated_at = now()
                where id = regrade_request_id;
            elsif is_bare_check and current_request.submission_comment_id is null
               and current_request.submission_file_comment_id is null
               and current_request.submission_artifact_comment_id is null then
                -- A bare-check request can be closed directly from 'opened' without a grader
                -- having resolved it; materialize the comment in that case too.
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
-- 3. Reading regrade requests: staff of the request's own class
-- ---------------------------------------------------------------------------

-- The student branches are unchanged. Reading isn't gated on handle_regrades (see the header).
DROP POLICY IF EXISTS "graders all, students own" ON public.submission_regrade_requests;
DROP POLICY IF EXISTS "Staff and the submission's students read regrade requests" ON public.submission_regrade_requests;
CREATE POLICY "Staff and the submission's students read regrade requests" ON public.submission_regrade_requests
  FOR SELECT TO authenticated
  USING (
    class_id IN (
      SELECT up.class_id FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.role IN ('instructor', 'grader')
    )
    OR EXISTS (
      SELECT 1
      FROM public.submissions s
      JOIN public.user_privileges ur ON ur.private_profile_id = s.profile_id
      WHERE s.id = submission_regrade_requests.submission_id AND ur.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.submissions s
      JOIN public.assignment_groups_members agm ON agm.assignment_group_id = s.assignment_group_id
      JOIN public.user_privileges ur ON ur.private_profile_id = agm.profile_id
      WHERE s.id = submission_regrade_requests.submission_id AND ur.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Commenting on a regrade request
-- ---------------------------------------------------------------------------

-- The request is read under the caller's own RLS, so it must be one they can see: staff of its
-- class, or a student on its submission. The author must be the caller's own profile in the
-- comment's class, private or public: staff post as their public profile in pseudonymous mode.
DROP POLICY IF EXISTS "allow_create_if_authorized_for_submission_regrade_comment" ON public.submission_regrade_request_comments;
DROP POLICY IF EXISTS "Regrade handlers and the submission's students can comment" ON public.submission_regrade_request_comments;
CREATE POLICY "Regrade handlers and the submission's students can comment" ON public.submission_regrade_request_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.submission_regrade_requests r
      WHERE r.id = submission_regrade_request_comments.submission_regrade_request_id
        AND r.class_id = submission_regrade_request_comments.class_id
        AND r.submission_id = submission_regrade_request_comments.submission_id
        AND r.assignment_id = submission_regrade_request_comments.assignment_id
    )
    AND EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = submission_regrade_request_comments.class_id
        AND (up.public_profile_id = submission_regrade_request_comments.author
             OR up.private_profile_id = submission_regrade_request_comments.author)
    )
    AND (
      class_id IN (SELECT public.user_class_ids_with_capability('handle_regrades'))
      OR public.authorize_for_submission_regrade_comment(submission_regrade_request_id)
    )
  );
