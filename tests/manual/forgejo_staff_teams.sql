-- Proof harness for 20261121170000_forgejo_staff_teams.sql (#1375).
--
-- Makes its own fixtures and ends in ROLLBACK. Run it in one transaction with the migration if the
-- migration isn't applied yet:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/manual/forgejo_staff_teams.sql
--
-- Scenarios:
--   1. a class with Forgejo repos lists its org, a `<slug>-staff` team, its non-disabled instructors,
--      graders and admins with a Forgejo account, and its ready repos and handout; not students, not a
--      staff member still waiting for an account, not a repo still being created, not a repo in another org
--   2. a class with no Forgejo repo or handout isn't listed
--   3. promoting a student, demoting or disabling staff, and deleting a staff role each kick the
--      reconciler; a student's edit doesn't
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.kicks() returns bigint language sql as $$
  select count(*) from net.http_request_queue where url like '%/functions/v1/forgejo-reconciler'
$$;

create temp table fx_class(name text primary key, id bigint);
with c as (
  insert into public.classes (name, slug, features, forgejo_org)
  values ('staff', 'Stf-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]', 'Stf-Org'),
         ('empty', 'emp-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]', null)
  returning id, name
)
insert into fx_class select name, id from c;
create or replace function pg_temp.cls(n text default 'staff') returns bigint language sql as $$
  select id from fx_class where name = n
$$;

-- prof: instructor. ta: grader. adm: admin. off: disabled grader. wait: grader with no account yet.
-- stu: student. All but wait have Forgejo logins.
create temp table fx(name text primary key, role public.app_role, disabled boolean, user_id uuid, priv uuid, pub uuid);
insert into fx values
  ('prof', 'instructor', false, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()),
  ('ta', 'grader', false, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()),
  ('adm', 'admin', false, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()),
  ('off', 'grader', true, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()),
  ('wait', 'grader', false, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()),
  ('stu', 'student', false, gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
insert into auth.users (id, email, aud, role)
select user_id, name || '-' || left(user_id::text, 8) || '@staff.test', 'authenticated', 'authenticated' from fx;
insert into public.profiles (id, class_id, is_private_profile, name)
select priv, pg_temp.cls(), true, name from fx union all select pub, pg_temp.cls(), false, name || ' (public)' from fx;
insert into public.user_roles (user_id, class_id, role, disabled, private_profile_id, public_profile_id)
select user_id, pg_temp.cls(), role, disabled, priv, pub from fx;
insert into public.git_accounts (user_id, provider, instance_url, remote_user_id, login)
select user_id, 'forgejo', 'https://git.test', 300 + row_number() over (order by name), 'login-' || name
from fx where name <> 'wait';
insert into public.git_accounts (user_id, provider, instance_url) select user_id, 'forgejo', 'https://git.test' from fx where name = 'wait';

with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id)
insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, repo_mode, template_repo,
                                git_provider, self_review_setting_id)
select pg_temp.cls(), 'hw1', 'hw1', now() + interval '7 days', now() - interval '1 hour', 'individual',
       'template_only_staff', 'Stf-Org/HW1-Handout', 'forgejo', s.id
from s;
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider, is_github_ready)
select a.id, pg_temp.cls(), (select priv from fx where name = 'stu'), r.repository, 'forgejo', r.ready
from public.assignments a,
  (values ('stf-org/stf-hw1-login-stu', true), ('stf-org/stf-hw1-pending', false), ('other-org/stf-hw1-x', true))
    as r(repository, ready)
where a.class_id = pg_temp.cls();

create temp table listed as select * from public.forgejo_staff_teams('https://git.test', NULL)
  where class_id in (select id from fx_class);

-- 1
select pg_temp.check('1a the class is listed once, with its lowercased org and <slug>-staff team',
  (select count(*) from listed where class_id = pg_temp.cls()) = 1
  and exists (select 1 from listed where class_id = pg_temp.cls() and org = 'stf-org'
              and team = lower((select slug from public.classes where id = pg_temp.cls())) || '-staff'),
  (select string_agg(org || ' ' || team, ', ') from listed));
select pg_temp.check('1b members are the enabled instructors, graders and admins with an account',
  (select logins from listed where class_id = pg_temp.cls()) = array['login-adm', 'login-prof', 'login-ta'],
  (select logins::text from listed where class_id = pg_temp.cls()));
select pg_temp.check('1c repos are the ready ones and the handout, in the class org, lowercased',
  (select repositories from listed where class_id = pg_temp.cls()) = array['stf-org/hw1-handout', 'stf-org/stf-hw1-login-stu'],
  (select repositories::text from listed where class_id = pg_temp.cls()));

-- 2
select pg_temp.check('2 a class with no Forgejo repos is not listed',
  not exists (select 1 from listed where class_id = pg_temp.cls('empty')));

-- 3
create temp table k(v bigint);
insert into k values (pg_temp.kicks());
update public.user_roles set role = 'grader' where user_id = (select user_id from fx where name = 'stu');
select pg_temp.check('3a promoting a student kicks', pg_temp.kicks() = (select v from k) + 1);
update k set v = pg_temp.kicks();
update public.user_roles set role = 'student' where user_id = (select user_id from fx where name = 'stu');
select pg_temp.check('3b demoting staff kicks', pg_temp.kicks() = (select v from k) + 1);
update k set v = pg_temp.kicks();
update public.user_roles set disabled = true where user_id = (select user_id from fx where name = 'ta');
select pg_temp.check('3c disabling staff kicks', pg_temp.kicks() = (select v from k) + 1);
update k set v = pg_temp.kicks();
update public.user_roles set disabled = true where user_id = (select user_id from fx where name = 'stu');
select pg_temp.check('3d disabling a student doesn''t kick for staff',
  pg_temp.kicks() = (select v from k), 'kicks: ' || (pg_temp.kicks() - (select v from k)));
update k set v = pg_temp.kicks();
delete from public.user_roles where user_id = (select user_id from fx where name = 'prof');
select pg_temp.check('3e deleting a staff role kicks', pg_temp.kicks() >= (select v from k) + 1);

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_staff_teams checks failed'; end if; end $$;

rollback;
