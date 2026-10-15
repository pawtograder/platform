-- Proof harness for 20261015120000_lock_down_security_definer_functions.sql.
--
-- Requires a seeded local DB (`npm run seed`, whose class is id 1). Run from the repo root; it all
-- happens in one transaction that ends in ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/security_definer_guards.sql
--
-- Each check runs as a real authenticated caller (role + request.jwt.claims, as PostgREST sets
-- them) and prints PASS/FAIL, then a failure count. Against the schema before the migration, the
-- exploit checks fail (15 of 26 on 2026-10-15); after it, 0 of 26.
\set ON_ERROR_STOP on
begin;

create temp table t_result(name text, ok boolean, detail text);
grant all on t_result to authenticated;

create or replace function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Fixtures ------------------------------------------------------------------------------------
create temp table fx as
select
  (select user_id from user_roles where class_id = 1 and role = 'instructor' limit 1) as instr,
  (select user_id from user_roles where class_id = 1 and role = 'grader' limit 1) as grader,
  (select user_id from user_roles where class_id = 1 and role = 'student' order by id limit 1) as stu1,
  (select private_profile_id from user_roles where class_id = 1 and role = 'student' order by id limit 1) as stu1_priv,
  (select user_id from user_roles where class_id = 1 and role = 'student' order by id offset 1 limit 1) as stu2,
  (select private_profile_id from user_roles where class_id = 1 and role = 'student' order by id offset 1 limit 1) as stu2_priv,
  (select private_profile_id from user_roles where class_id = 1 and role = 'instructor' limit 1) as instr_priv,
  (select private_profile_id from user_roles where class_id = 1 and role = 'grader' limit 1) as grader_priv;
grant select on fx to authenticated;

-- A second class with an admin enrollment, a survey and an assignment.
insert into classes (id, name, slug, term) values (900001, 'Other class', 'other-class-900001', 202610);
insert into auth.users (id, email, aud, role, instance_id) values ('00000000-0000-0000-0000-00000000a001', 'audit-admin@example.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into users (user_id, email, name) values ('00000000-0000-0000-0000-00000000a001', 'audit-admin@example.com', 'Audit Admin') on conflict (user_id) do nothing;
insert into profiles (id, name, class_id, is_private_profile) values
  ('00000000-0000-0000-0000-00000000b001', 'Audit Admin', 900001, true),
  ('00000000-0000-0000-0000-00000000b002', 'audit-admin-pub', 900001, false);
insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
values ('00000000-0000-0000-0000-00000000a001', 900001, 'admin', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b002');
insert into assignments
select (jsonb_populate_record(null::assignments, to_jsonb(a) || '{"id": 900001, "class_id": 900001, "slug": "other-a", "title": "Other A"}'::jsonb || jsonb_build_object('release_date', now() + interval '7 days', 'due_date', now() + interval '14 days')
        - 'self_review_setting_id' - 'grading_rubric_id' - 'meta_grading_rubric_id' - 'self_review_rubric_id' - 'gradebook_column_id')).*
from assignments a where a.class_id = 1 order by a.id limit 1;
insert into surveys (id, class_id, created_by, title, survey_id, type, assigned_to_all)
select gen_random_uuid(), 900001, '00000000-0000-0000-0000-00000000b001', 'Other survey', s.survey_id, 'assign_all', true
from surveys s where s.class_id = 1 order by s.id limit 1;
create temp table fx_survey as select id, survey_id from surveys where class_id = 1 and deleted_at is null order by id limit 1;
grant select on fx_survey to authenticated;

-- Runs p_sql as p_uid; records ok when the outcome matches p_expect_error.
create or replace function pg_temp.expect(p_name text, p_uid uuid, p_sql text, p_expect_error boolean) returns void
language plpgsql as $$
declare v_err text;
begin
  perform pg_temp.as_user(p_uid);
  begin
    execute p_sql;
    v_err := null;
  exception when others then
    v_err := sqlerrm;
  end;
  perform pg_temp.as_postgres();
  insert into t_result values (p_name, (v_err is not null) = p_expect_error, coalesce(v_err, 'no error'));
end $$;

-- Raises unless the boolean query returns p_expected.
create or replace function pg_temp.expect_bool(p_name text, p_uid uuid, p_sql text, p_expected boolean) returns void
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(p_uid);
  execute p_sql into v;
  perform pg_temp.as_postgres();
  insert into t_result values (p_name, v is not distinct from p_expected, coalesce(v::text, 'null'));
end $$;

grant execute on all functions in schema pg_temp to authenticated;

-- 4a authorize_for_admin -----------------------------------------------------------------------
select pg_temp.expect_bool('admin: self check true', '00000000-0000-0000-0000-00000000a001', 'select public.authorize_for_admin()', true);
select pg_temp.expect_bool('instructor: passing an admin uuid is false', (select instr from fx),
  $q$select public.authorize_for_admin('00000000-0000-0000-0000-00000000a001')$q$, false);
select pg_temp.expect('instructor: admin_update_class with admin uuid as p_updated_by denied', (select instr from fx),
  $q$select public.admin_update_class(1, p_updated_by => '00000000-0000-0000-0000-00000000a001', p_name => 'pwned')$q$, true);

-- 4b admin role grants -------------------------------------------------------------------------
select pg_temp.expect('instructor: insert admin user_roles row denied', (select instr from fx),
  $q$insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
     select stu1, 1, 'admin', gen_random_uuid(), gen_random_uuid() from fx$q$, true);
select pg_temp.expect('instructor: promote student row to admin denied', (select instr from fx),
  $q$update user_roles set role = 'admin' where class_id = 1 and user_id = (select stu1 from fx)$q$, true);
select pg_temp.expect('instructor: create_invitation as admin denied', (select instr from fx),
  $q$select public.create_invitation(1, 'admin', 999123, 'x@example.com', 'X')$q$, true);
select pg_temp.expect('instructor: still can promote student to grader', (select instr from fx),
  $q$update user_roles set role = 'grader' where class_id = 1 and user_id = (select stu2 from fx)$q$, false);
select pg_temp.expect('admin: admin_create_class (inserts an admin role row) allowed', '00000000-0000-0000-0000-00000000a001',
  $q$select public.admin_create_class('Audit created', 202610)$q$, false);
select pg_temp.expect('instructor: admin_create_class denied', (select instr from fx),
  $q$select public.admin_create_class('Audit created 2', 202610)$q$, true);

-- 4c gradebook cell RPC --------------------------------------------------------------------------
create temp table fx_gcs as select g.id from gradebook_column_students g where g.class_id = 1 and g.student_id = (select stu1_priv from fx) order by g.id limit 1;
grant select on fx_gcs to authenticated;
select pg_temp.expect('student: update own gradebook cell denied', (select stu1 from fx),
  $q$select public.update_gradebook_column_student_with_recalc((select id from fx_gcs), '{"score_override": 100}')$q$, true);
select pg_temp.expect('grader: update gradebook cell allowed', (select grader from fx),
  $q$select public.update_gradebook_column_student_with_recalc((select id from fx_gcs), '{"score_override_note": "audit"}')$q$, false);

-- 4d release instructor-only column ------------------------------------------------------------------
select pg_temp.expect('grader: release instructor-only column denied', (select grader from fx),
  $q$select public.release_instructor_only_gradebook_column((select id from gradebook_columns where class_id = 1 and instructor_only limit 1))$q$, true);
select pg_temp.expect('instructor: release instructor-only column allowed', (select instr from fx),
  $q$select public.release_instructor_only_gradebook_column((select id from gradebook_columns where class_id = 1 and instructor_only limit 1))$q$, false);

-- 4e soft_delete_survey ----------------------------------------------------------------------------
select pg_temp.expect('instructor: soft_delete_survey own survey allowed', (select instr from fx),
  $q$select public.soft_delete_survey((select id from fx_survey), (select survey_id from fx_survey))$q$, false);
insert into t_result
select 'soft_delete_survey left the other class''s survey alone', deleted_at is null, coalesce(deleted_at::text, 'null')
from surveys where class_id = 900001;

-- 4f update_rubric_full ------------------------------------------------------------------------------
select pg_temp.expect('instructor: rubric against another class''s assignment denied', (select instr from fx),
  $q$select public.update_rubric_full('{"class_id": 1, "assignment_id": 900001, "name": "x", "review_round": "code-walk", "parts": []}')$q$, true);

-- 4g regrade status ----------------------------------------------------------------------------------
create temp table fx_rr as
select r.id, r.status, s.profile_id as owner
from submission_regrade_requests r join submissions s on s.id = r.submission_id
where r.class_id = 1 and r.status = 'resolved' and s.assignment_group_id is null limit 1;
grant select on fx_rr to authenticated;
select pg_temp.expect('student: escalate someone else''s regrade denied',
  (select ur.user_id from user_roles ur where ur.class_id = 1 and ur.role = 'student' and ur.private_profile_id <> (select owner from fx_rr) limit 1),
  $q$select public.update_regrade_request_status((select id from fx_rr), 'escalated',
       (select ur.private_profile_id from user_roles ur where ur.user_id = auth.uid() and ur.class_id = 1))$q$, true);
select pg_temp.expect('owner: escalate own regrade allowed',
  (select ur.user_id from user_roles ur where ur.private_profile_id = (select owner from fx_rr)),
  $q$select public.update_regrade_request_status((select id from fx_rr), 'escalated', (select owner from fx_rr))$q$, false);
select pg_temp.expect('admin of other class: act on class 1 regrade with own profile denied', '00000000-0000-0000-0000-00000000a001',
  $q$select public.update_regrade_request_status((select id from fx_rr), 'closed', '00000000-0000-0000-0000-00000000b001', closed_points => 0)$q$, true);

-- 4h get_student_summary ----------------------------------------------------------------------------
select pg_temp.expect('student: own summary denied', (select stu1 from fx),
  $q$select public.get_student_summary(1, (select stu1_priv from fx))$q$, true);
select pg_temp.expect('instructor: student summary allowed', (select instr from fx),
  $q$select public.get_student_summary(1, (select stu1_priv from fx))$q$, false);

-- 4i check_can_add_to_help_request -------------------------------------------------------------------
select pg_temp.expect_bool('help request: mismatched class is false', (select instr from fx),
  $q$select public.check_can_add_to_help_request((select id from help_requests where class_id = 1 limit 1), auth.uid(), 900001)$q$, false);
select pg_temp.expect_bool('help request: staff in own class is true', (select instr from fx),
  $q$select public.check_can_add_to_help_request((select id from help_requests where class_id = 1 limit 1), auth.uid(), 1)$q$, true);
select pg_temp.expect_bool('help request: non-member of class is false', '00000000-0000-0000-0000-00000000a001',
  $q$select public.check_can_add_to_help_request((select id from help_requests where class_id = 1 and not is_private limit 1), auth.uid(), 1)$q$, false);

-- Revoked internals are not callable by authenticated -----------------------------------------
select pg_temp.expect('authenticated: enqueue_github_create_repo denied', (select instr from fx),
  $q$select public.enqueue_github_create_repo(1, 'o', 'r', 't', 's', array[]::text[])$q$, true);
select pg_temp.expect('authenticated: get_assessment_export_pepper denied', (select instr from fx),
  $q$select public.get_assessment_export_pepper()$q$, true);

select case when ok then 'PASS' else 'FAIL' end, name, left(detail, 110) from t_result;
select count(*) filter (where not ok) as failures, count(*) as total from t_result;
rollback;
