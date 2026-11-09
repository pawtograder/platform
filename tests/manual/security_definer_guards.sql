-- Proof harness for 20261015120000_lock_down_security_definer_functions.sql.
--
-- Requires a seeded local DB (`npm run seed`). The seed class is picked as the one holding the
-- seed's graders and regrade requests (id 2 after a fresh `supabase db reset`, where the demo
-- class takes id 1). Run from the repo root; it all happens in one transaction that ends in
-- ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/security_definer_guards.sql
--
-- Each check runs as a real authenticated caller (role + request.jwt.claims, as PostgREST sets
-- them) and prints PASS/FAIL, then a failure count; every check should pass after the migration.
-- Against the schema before it, the exploit checks fail (15 of the first 26 on 2026-10-15).
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
create temp table fx_class as
select r.class_id as id
from submission_regrade_requests r
where exists (select 1 from user_roles g where g.class_id = r.class_id and g.role = 'grader')
group by r.class_id order by count(*) desc limit 1;
grant select on fx_class to authenticated;
create or replace function pg_temp.cls() returns bigint language sql stable as $$ select id from pg_temp.fx_class $$;

create temp table fx as
select
  (select user_id from user_roles where class_id = pg_temp.cls() and role = 'instructor' limit 1) as instr,
  (select user_id from user_roles where class_id = pg_temp.cls() and role = 'grader' limit 1) as grader,
  (select user_id from user_roles where class_id = pg_temp.cls() and role = 'student' order by id limit 1) as stu1,
  (select private_profile_id from user_roles where class_id = pg_temp.cls() and role = 'student' order by id limit 1) as stu1_priv,
  (select user_id from user_roles where class_id = pg_temp.cls() and role = 'student' order by id offset 1 limit 1) as stu2,
  (select private_profile_id from user_roles where class_id = pg_temp.cls() and role = 'student' order by id offset 1 limit 1) as stu2_priv,
  (select private_profile_id from user_roles where class_id = pg_temp.cls() and role = 'instructor' limit 1) as instr_priv,
  (select private_profile_id from user_roles where class_id = pg_temp.cls() and role = 'grader' limit 1) as grader_priv;
grant select on fx to authenticated;

-- A second class with an admin enrollment, a survey and an assignment.
insert into classes (id, name, slug, term) values (900001, 'Other class', 'other-class-900001', 202610);
insert into auth.users (id, email, aud, role, instance_id) values ('00000000-0000-0000-0000-00000000a001', 'audit-admin@example.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into users (user_id, email, name) values ('00000000-0000-0000-0000-00000000a001', 'audit-admin@example.com', 'Audit Admin') on conflict (user_id) do nothing;
-- user_register_create_demo_account enrolls new users in the demo class; undo that.
delete from gradebook_column_students where student_id in (select private_profile_id from user_roles where user_id = '00000000-0000-0000-0000-00000000a001');
delete from user_roles where user_id = '00000000-0000-0000-0000-00000000a001';
insert into profiles (id, name, class_id, is_private_profile) values
  ('00000000-0000-0000-0000-00000000b001', 'Audit Admin', 900001, true),
  ('00000000-0000-0000-0000-00000000b002', 'audit-admin-pub', 900001, false);
insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
values ('00000000-0000-0000-0000-00000000a001', 900001, 'admin', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b002');
insert into assignments
select (jsonb_populate_record(null::assignments, to_jsonb(a) || '{"id": 900001, "class_id": 900001, "slug": "other-a", "title": "Other A"}'::jsonb || jsonb_build_object('release_date', now() + interval '7 days', 'due_date', now() + interval '14 days')
        - 'self_review_setting_id' - 'grading_rubric_id' - 'meta_grading_rubric_id' - 'self_review_rubric_id' - 'gradebook_column_id')).*
from assignments a where a.class_id = pg_temp.cls() order by a.id limit 1;
insert into surveys (id, class_id, created_by, title, survey_id, type, assigned_to_all)
select gen_random_uuid(), 900001, '00000000-0000-0000-0000-00000000b001', 'Other survey', s.survey_id, 'assign_all', true
from surveys s where s.class_id = pg_temp.cls() and s.deleted_at is null order by s.id limit 1;
create temp table fx_survey as select id, survey_id from surveys where class_id = pg_temp.cls() and deleted_at is null order by id limit 1;
grant select on fx_survey to authenticated;

-- The audit admin also holds an admin row in the seed class (as admin_create_class leaves one),
-- and the seed class has a dropped admin invitation.
insert into profiles (id, name, class_id, is_private_profile) values
  ('00000000-0000-0000-0000-00000000b003', 'Audit Admin', pg_temp.cls(), true),
  ('00000000-0000-0000-0000-00000000b004', 'audit-admin-pub-1', pg_temp.cls(), false),
  ('00000000-0000-0000-0000-00000000b005', 'Invited Admin', pg_temp.cls(), true),
  ('00000000-0000-0000-0000-00000000b006', 'invited-admin-pub', pg_temp.cls(), false);
insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
values ('00000000-0000-0000-0000-00000000a001', pg_temp.cls(), 'admin', '00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000b004');
insert into invitations (class_id, role, sis_user_id, email, name, public_profile_id, private_profile_id, status)
values (pg_temp.cls(), 'admin', 999001, 'invited-admin@example.com', 'Invited Admin',
        '00000000-0000-0000-0000-00000000b006', '00000000-0000-0000-0000-00000000b005', 'dropped');

-- A user with no roles yet, for the first-role welcome trigger.
insert into auth.users (id, email, aud, role, instance_id) values ('00000000-0000-0000-0000-00000000a002', 'audit-new@example.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into users (user_id, email, name) values ('00000000-0000-0000-0000-00000000a002', 'audit-new@example.com', 'Audit New') on conflict (user_id) do nothing;
-- user_register_create_demo_account enrolls new users in the demo class; undo that.
delete from gradebook_column_students where student_id in (select private_profile_id from user_roles where user_id = '00000000-0000-0000-0000-00000000a002');
delete from user_roles where user_id = '00000000-0000-0000-0000-00000000a002';
insert into profiles (id, name, class_id, is_private_profile) values
  ('00000000-0000-0000-0000-00000000b007', 'Audit New', pg_temp.cls(), true),
  ('00000000-0000-0000-0000-00000000b008', 'audit-new-pub', pg_temp.cls(), false);

-- A user enrolled only in the other class.
insert into auth.users (id, email, aud, role, instance_id) values ('00000000-0000-0000-0000-00000000a003', 'audit-other@example.com', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
insert into users (user_id, email, name) values ('00000000-0000-0000-0000-00000000a003', 'audit-other@example.com', 'Audit Other') on conflict (user_id) do nothing;
-- user_register_create_demo_account enrolls new users in the demo class; undo that.
delete from gradebook_column_students where student_id in (select private_profile_id from user_roles where user_id = '00000000-0000-0000-0000-00000000a003');
delete from user_roles where user_id = '00000000-0000-0000-0000-00000000a003';
insert into profiles (id, name, class_id, is_private_profile) values
  ('00000000-0000-0000-0000-00000000b009', 'Audit Other', 900001, true),
  ('00000000-0000-0000-0000-00000000b00a', 'audit-other-pub', 900001, false);
insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
values ('00000000-0000-0000-0000-00000000a003', 900001, 'student', '00000000-0000-0000-0000-00000000b009', '00000000-0000-0000-0000-00000000b00a');

-- A rubric check in the other class.
insert into rubric_parts
select (jsonb_populate_record(null::rubric_parts, to_jsonb(p) || jsonb_build_object('id', 900001, 'class_id', 900001, 'assignment_id', 900001,
        'rubric_id', (select id from rubrics where class_id = 900001 order by id limit 1)))).*
from rubric_parts p where p.class_id = pg_temp.cls() order by p.id limit 1;
insert into rubric_criteria
select (jsonb_populate_record(null::rubric_criteria, to_jsonb(c) || jsonb_build_object('id', 900001, 'class_id', 900001, 'assignment_id', 900001,
        'rubric_part_id', 900001, 'rubric_id', (select id from rubrics where class_id = 900001 order by id limit 1)))).*
from rubric_criteria c where c.class_id = pg_temp.cls() order by c.id limit 1;
insert into rubric_checks
select (jsonb_populate_record(null::rubric_checks, to_jsonb(k) || jsonb_build_object('id', 900001, 'class_id', 900001, 'assignment_id', 900001,
        'rubric_criteria_id', 900001, 'rubric_id', (select id from rubrics where class_id = 900001 order by id limit 1)))).*
from rubric_checks k where k.class_id = pg_temp.cls() order by k.id limit 1;
create temp table fx_rubric as select id, assignment_id, review_round from rubrics where class_id = pg_temp.cls() order by id limit 1;
grant select on fx_rubric to authenticated;

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

-- Records ok when the boolean query returns p_expected.
create or replace function pg_temp.expect_bool(p_name text, p_uid uuid, p_sql text, p_expected boolean) returns void
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(p_uid);
  execute p_sql into v;
  perform pg_temp.as_postgres();
  insert into t_result values (p_name, v is not distinct from p_expected, coalesce(v::text, 'null'));
end $$;

-- Records ok when p_sql raises an error whose message contains p_like.
create or replace function pg_temp.expect_error_like(p_name text, p_uid uuid, p_sql text, p_like text) returns void
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
  insert into t_result values (p_name, coalesce(v_err like '%' || p_like || '%', false), coalesce(v_err, 'no error'));
end $$;

grant execute on all functions in schema pg_temp to authenticated;

-- 4a authorize_for_admin -----------------------------------------------------------------------
select pg_temp.expect_bool('admin: self check true', '00000000-0000-0000-0000-00000000a001', 'select public.authorize_for_admin()', true);
select pg_temp.expect_bool('instructor: passing an admin uuid is false', (select instr from fx),
  $q$select public.authorize_for_admin('00000000-0000-0000-0000-00000000a001')$q$, false);
select pg_temp.expect('instructor: admin_update_class with admin uuid as p_updated_by denied', (select instr from fx),
  $q$select public.admin_update_class(pg_temp.cls(), p_updated_by => '00000000-0000-0000-0000-00000000a001', p_name => 'pwned')$q$, true);

-- 4b admin role grants -------------------------------------------------------------------------
select pg_temp.expect('instructor: insert admin user_roles row denied', (select instr from fx),
  $q$insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
     select stu1, pg_temp.cls(), 'admin', gen_random_uuid(), gen_random_uuid() from fx$q$, true);
select pg_temp.expect('instructor: promote student row to admin denied', (select instr from fx),
  $q$update user_roles set role = 'admin' where class_id = pg_temp.cls() and user_id = (select stu1 from fx)$q$, true);
select pg_temp.expect('instructor: create_invitation as admin denied', (select instr from fx),
  $q$select public.create_invitation(pg_temp.cls(), 'admin', 999123, 'x@example.com', 'X')$q$, true);
select pg_temp.expect('instructor: still can promote student to grader', (select instr from fx),
  $q$update user_roles set role = 'grader' where class_id = pg_temp.cls() and user_id = (select stu2 from fx)$q$, false);
select pg_temp.expect('admin: admin_create_class (inserts an admin role row) allowed', '00000000-0000-0000-0000-00000000a001',
  $q$select public.admin_create_class('Audit created', 202610)$q$, false);
select pg_temp.expect('instructor: admin_create_class denied', (select instr from fx),
  $q$select public.admin_create_class('Audit created 2', 202610)$q$, true);
select pg_temp.expect('instructor: demote the admin row in own class denied', (select instr from fx),
  $q$update user_roles set role = 'student' where class_id = pg_temp.cls() and user_id = '00000000-0000-0000-0000-00000000a001'$q$, true);
select pg_temp.expect('instructor: disable the admin row in own class denied', (select instr from fx),
  $q$update user_roles set disabled = true where class_id = pg_temp.cls() and user_id = '00000000-0000-0000-0000-00000000a001'$q$, true);
select pg_temp.expect('instructor: delete the admin row in own class denied', (select instr from fx),
  $q$delete from user_roles where class_id = pg_temp.cls() and user_id = '00000000-0000-0000-0000-00000000a001'$q$, true);
insert into t_result
select 'admin row in the seed class still enabled after those attempts', count(*) = 1, count(*)::text
from user_roles where class_id = pg_temp.cls() and user_id = '00000000-0000-0000-0000-00000000a001' and role = 'admin' and not disabled;
select pg_temp.expect('instructor: still can disable a student row', (select instr from fx),
  $q$update user_roles set disabled = true where class_id = pg_temp.cls() and user_id = (select stu2 from fx)$q$, false);
select pg_temp.expect('instructor: retarget admin invitation (sis_user_id) denied', (select instr from fx),
  $q$update invitations set sis_user_id = 999002 where sis_user_id = 999001$q$, true);
select pg_temp.expect('instructor: reactivate dropped admin invitation denied', (select instr from fx),
  $q$update invitations set status = 'pending' where sis_user_id = 999001$q$, true);
select pg_temp.expect('instructor: rename admin invitation allowed', (select instr from fx),
  $q$update invitations set name = 'Renamed' where sis_user_id = 999001$q$, false);
select pg_temp.expect('admin: reactivate admin invitation allowed', '00000000-0000-0000-0000-00000000a001',
  $q$update invitations set status = 'pending' where sis_user_id = 999001$q$, false);

-- 4c gradebook cell RPC --------------------------------------------------------------------------
create temp table fx_gcs as select g.id from gradebook_column_students g where g.class_id = pg_temp.cls() and g.student_id = (select stu1_priv from fx) order by g.id limit 1;
grant select on fx_gcs to authenticated;
select pg_temp.expect('student: update own gradebook cell denied', (select stu1 from fx),
  $q$select public.update_gradebook_column_student_with_recalc((select id from fx_gcs), '{"score_override": 100}')$q$, true);
select pg_temp.expect('grader: update gradebook cell allowed', (select grader from fx),
  $q$select public.update_gradebook_column_student_with_recalc((select id from fx_gcs), '{"score_override_note": "audit"}')$q$, false);

-- 4d release instructor-only column ------------------------------------------------------------------
select pg_temp.expect('grader: release instructor-only column denied', (select grader from fx),
  $q$select public.release_instructor_only_gradebook_column((select id from gradebook_columns where class_id = pg_temp.cls() and instructor_only limit 1))$q$, true);
select pg_temp.expect('instructor: release instructor-only column allowed', (select instr from fx),
  $q$select public.release_instructor_only_gradebook_column((select id from gradebook_columns where class_id = pg_temp.cls() and instructor_only limit 1))$q$, false);

-- 4e soft_delete_survey ----------------------------------------------------------------------------
select pg_temp.expect('instructor: soft_delete_survey own survey allowed', (select instr from fx),
  $q$select public.soft_delete_survey((select id from fx_survey), (select survey_id from fx_survey))$q$, false);
insert into t_result
select 'soft_delete_survey left the other class''s survey alone', deleted_at is null, coalesce(deleted_at::text, 'null')
from surveys where class_id = 900001;

-- 4f update_rubric_full ------------------------------------------------------------------------------
select pg_temp.expect('instructor: rubric against another class''s assignment denied', (select instr from fx),
  $q$select public.update_rubric_full(jsonb_build_object('class_id', pg_temp.cls(), 'assignment_id', 900001, 'name', 'x', 'review_round', 'code-walk', 'parts', '[]'::jsonb))$q$, true);
select pg_temp.expect_error_like('instructor: rubric referencing another class''s check denied', (select instr from fx),
  $q$select public.update_rubric_full(jsonb_build_object('id', r.id, 'class_id', pg_temp.cls(), 'assignment_id', r.assignment_id, 'name', 'x',
       'review_round', r.review_round, 'parts', jsonb_build_array(jsonb_build_object('name', 'p', 'criteria', jsonb_build_array(
         jsonb_build_object('name', 'c', 'checks', jsonb_build_array(jsonb_build_object('name', 'k',
           'references', jsonb_build_array(jsonb_build_object('referenced_rubric_check_id', 900001)))))))))) from fx_rubric r$q$,
  'Referenced rubric check does not belong');

-- 4g regrade status ----------------------------------------------------------------------------------
create temp table fx_rr as
select r.id, r.status, s.profile_id as owner
from submission_regrade_requests r join submissions s on s.id = r.submission_id
where r.class_id = pg_temp.cls() and r.status = 'resolved' and s.assignment_group_id is null limit 1;
grant select on fx_rr to authenticated;
select pg_temp.expect('student: escalate someone else''s regrade denied',
  (select ur.user_id from user_roles ur where ur.class_id = pg_temp.cls() and ur.role = 'student' and ur.private_profile_id <> (select owner from fx_rr) limit 1),
  $q$select public.update_regrade_request_status((select id from fx_rr), 'escalated',
       (select ur.private_profile_id from user_roles ur where ur.user_id = auth.uid() and ur.class_id = pg_temp.cls()))$q$, true);
select pg_temp.expect('owner: escalate own regrade allowed',
  (select ur.user_id from user_roles ur where ur.private_profile_id = (select owner from fx_rr)),
  $q$select public.update_regrade_request_status((select id from fx_rr), 'escalated', (select owner from fx_rr))$q$, false);
select pg_temp.expect('admin of other class: act on the seed class regrade with own profile denied', '00000000-0000-0000-0000-00000000a001',
  $q$select public.update_regrade_request_status((select id from fx_rr), 'closed', '00000000-0000-0000-0000-00000000b001', closed_points => 0)$q$, true);

-- 4h get_student_summary ----------------------------------------------------------------------------
select pg_temp.expect('student: own summary allowed', (select stu1 from fx),
  $q$select public.get_student_summary(pg_temp.cls(), (select stu1_priv from fx))$q$, false);
select pg_temp.expect_bool('student: own summary omits private grades', (select stu1 from fx),
  $q$select jsonb_array_length(public.get_student_summary(pg_temp.cls(), (select stu1_priv from fx))->'grades_private') = 0$q$, true);
select pg_temp.expect('student: another student''s summary denied', (select stu1 from fx),
  $q$select public.get_student_summary(pg_temp.cls(), (select stu2_priv from fx))$q$, true);
select pg_temp.expect_bool('instructor: summary includes private grades', (select instr from fx),
  $q$select jsonb_array_length(public.get_student_summary(pg_temp.cls(), (select stu1_priv from fx))->'grades_private') > 0$q$, true);
select pg_temp.expect('instructor: student summary allowed', (select instr from fx),
  $q$select public.get_student_summary(pg_temp.cls(), (select stu1_priv from fx))$q$, false);

-- Help request membership (20261014120000 replaced check_can_add_to_help_request with
-- can_add_profile_to_help_request; this migration must leave its class scoping intact) ----------
-- Picked as postgres: the callers below cannot all see the row under RLS.
create temp table fx_hr_open as select id from help_requests where class_id = pg_temp.cls() and not is_private order by id limit 1;
grant select on fx_hr_open to authenticated;
select pg_temp.expect_bool('help request: staff of the class can add a class member', (select instr from fx),
  $q$select public.can_add_profile_to_help_request((select id from fx_hr_open), (select stu1_priv from fx))$q$, true);
select pg_temp.expect_bool('help request: member of another class cannot add to it', '00000000-0000-0000-0000-00000000a003',
  $q$select public.can_add_profile_to_help_request((select id from fx_hr_open), '00000000-0000-0000-0000-00000000b009')$q$, false);

-- 4i welcome message -------------------------------------------------------------------------------
select pg_temp.expect('authenticated: send_signup_welcome_message denied', (select stu1 from fx),
  $q$select public.send_signup_welcome_message((select stu2 from fx))$q$, true);
select pg_temp.expect('instructor: adding a first role (fires the welcome trigger) allowed', (select instr from fx),
  $q$insert into user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
     values ('00000000-0000-0000-0000-00000000a002', pg_temp.cls(), 'student', '00000000-0000-0000-0000-00000000b007', '00000000-0000-0000-0000-00000000b008')$q$, false);

-- 4j due dates -------------------------------------------------------------------------------------
select pg_temp.expect('student: own final due date allowed', (select stu1 from fx),
  $q$select public.calculate_final_due_date((select id from assignments where class_id = pg_temp.cls() order by id limit 1), (select stu1_priv from fx))$q$, false);
select pg_temp.expect('student: another student''s final due date denied', (select stu1 from fx),
  $q$select public.calculate_final_due_date((select id from assignments where class_id = pg_temp.cls() order by id limit 1), (select stu2_priv from fx))$q$, true);
select pg_temp.expect('student: another student''s effective due date denied', (select stu1 from fx),
  $q$select public.calculate_effective_due_date((select id from assignments where class_id = pg_temp.cls() order by id limit 1), (select stu2_priv from fx))$q$, true);
select pg_temp.expect('student: own profile with someone else''s group denied', (select stu1 from fx),
  $q$select public.calculate_final_due_date(m.assignment_id, (select stu1_priv from fx), m.assignment_group_id)
     from assignment_groups_members m
     where m.class_id = pg_temp.cls() and not exists (select 1 from assignment_groups_members o where o.assignment_group_id = m.assignment_group_id and o.profile_id = (select stu1_priv from fx))
     limit 1$q$, true);
select pg_temp.expect('grader: a student''s final due date allowed', (select grader from fx),
  $q$select public.calculate_final_due_date((select id from assignments where class_id = pg_temp.cls() order by id limit 1), (select stu2_priv from fx))$q$, false);
select pg_temp.expect('student: assignments_with_effective_due_dates view still readable', (select stu1 from fx),
  $q$select count(*) from assignments_with_effective_due_dates$q$, false);
select pg_temp.expect('student: dashboard RPC still works', (select stu1 from fx),
  $q$select count(*) from public.get_assignments_for_student_dashboard(pg_temp.cls(), (select stu1_priv from fx))$q$, false);
select pg_temp.expect('instructor: assignments_with_effective_due_dates view still readable', (select instr from fx),
  $q$select count(*) from assignments_with_effective_due_dates$q$, false);
select pg_temp.expect('instructor: submissions_with_grades view still readable', (select instr from fx),
  $q$select count(*) from submissions_with_grades_for_assignment_and_regression_test$q$, false);

-- 4k user_is_in_help_request --------------------------------------------------------------------------
create temp table fx_hr as
select hr.id, up.user_id as creator from help_requests hr join user_privileges up on up.private_profile_id = hr.created_by
where hr.class_id = pg_temp.cls() and up.user_id <> (select stu1 from fx) limit 1;
grant select on fx_hr to authenticated;
select pg_temp.expect_bool('help request: asking about another user is false', (select stu1 from fx),
  $q$select public.user_is_in_help_request((select id from fx_hr), (select creator from fx_hr))$q$, false);
select pg_temp.expect_bool('help request: creator asking about self is true', (select creator from fx_hr),
  $q$select public.user_is_in_help_request((select id from fx_hr))$q$, true);

-- Revoked internals are not callable by authenticated -----------------------------------------
select pg_temp.expect('authenticated: enqueue_github_create_repo denied', (select instr from fx),
  $q$select public.enqueue_github_create_repo(pg_temp.cls(), 'o', 'r', 't', 's', array[]::text[])$q$, true);
select pg_temp.expect('authenticated: get_assessment_export_pepper denied', (select instr from fx),
  $q$select public.get_assessment_export_pepper()$q$, true);
-- These bodies already reject non-service callers, so check the grant itself.
insert into t_result
select 'authenticated has no EXECUTE on ' || f, not has_function_privilege('authenticated', f, 'EXECUTE'), f
from unnest(array['public.get_assignment_llm_metrics()', 'public.get_llm_tags_breakdown()',
                  'public.merge_class_feature_as_service_role(bigint, text, boolean)',
                  'public.is_instructor_for_student(uuid, uuid)']) f;

select case when ok then 'PASS' else 'FAIL' end, name, left(detail, 110) from t_result;
select count(*) filter (where not ok) as failures, count(*) as total from t_result;
rollback;
