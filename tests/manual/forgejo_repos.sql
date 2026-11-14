-- Proof harness for 20261112120200_forgejo_repos.sql (#1093).
--
-- Makes its own fixtures and ends in ROLLBACK. Kicks show up as pg_net requests to forgejo-reconciler,
-- queued inside this transaction, so nothing is sent:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/forgejo_repos.sql
--
-- Scenarios:
--   1. a student with a Forgejo login in a released Forgejo assignment is listed, as <org>/<slug>-<login>
--   2. the org is classes.forgejo_org, or the class slug when that is unset
--   3. not listed: no login yet, a disabled role, staff, another instance, a future release, a GitHub
--      assignment, a group assignment, a fork mode, no template, the flag turned off
--   4. a ready repo row takes the student off the list; a row that isn't ready doesn't
--   5. releasing a Forgejo assignment kicks forgejo-reconciler once and enqueues no GitHub repo,
--      also for a class with no github_org; releasing a GitHub assignment doesn't kick
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;

create or replace function pg_temp.kicks() returns bigint language sql as $$
  select count(*) from net.http_request_queue where url like '%/functions/v1/forgejo-reconciler'
$$;

-- Fixtures are created before the kick count is read; enrolling in a flagged class kicks too.
create temp table fx(name text primary key, id uuid);
insert into fx select 'u' || g, gen_random_uuid() from generate_series(1, 5) g;
insert into auth.users (id, email, aud, role)
select id, name || '-' || left(id::text, 8) || '@repos.test', 'authenticated', 'authenticated' from fx;

create temp table fx_class(name text primary key, id bigint, slug text);
with c as (
  -- 'orgless' has neither forgejo_org nor github_org; 'named' has both.
  insert into public.classes (name, slug, features, forgejo_org, github_org)
  values ('orgless', 'repos-a-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]', null, null),
         ('named', 'repos-b-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]', 'cs-forgejo',
          'repos-test-org')
  returning id, name, slug
)
insert into fx_class select name, id, slug from c;
create or replace function pg_temp.cls(p text) returns bigint language sql as $$ select id from fx_class where name = p $$;

create temp table fx_profiles as
select fx.name as user_name, fx.id as user_id, c.name as class_name, c.id as class_id,
       gen_random_uuid() as priv, gen_random_uuid() as pub
from fx cross join fx_class c;
insert into public.profiles (id, class_id, is_private_profile, name)
select priv, class_id, true, user_name from fx_profiles
union all select pub, class_id, false, user_name || ' (public)' from fx_profiles;

create or replace function pg_temp.enroll(p_user text, p_class text, p_role public.app_role, p_disabled boolean default false)
returns void language sql as $$
  insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id, disabled)
  select user_id, class_id, p_role, priv, pub, p_disabled from fx_profiles where user_name = p_user and class_name = p_class
$$;
create or replace function pg_temp.priv(p_user text, p_class text) returns uuid language sql as $$
  select priv from fx_profiles where user_name = p_user and class_name = p_class
$$;
-- u1: student with a login. u2: student whose account is still being created. u3: disabled student.
-- u4: instructor with a login. u5: student with a login on another instance.
select pg_temp.enroll('u1', 'orgless', 'student'), pg_temp.enroll('u1', 'named', 'student'),
       pg_temp.enroll('u2', 'orgless', 'student'), pg_temp.enroll('u3', 'orgless', 'student', true),
       pg_temp.enroll('u4', 'orgless', 'instructor'), pg_temp.enroll('u5', 'orgless', 'student');
insert into public.git_accounts (user_id, provider, instance_url, remote_user_id, login)
values ((select id from fx where name = 'u1'), 'forgejo', 'https://git.test', 101, 'alex'),
       ((select id from fx where name = 'u3'), 'forgejo', 'https://git.test', 103, 'casey'),
       ((select id from fx where name = 'u4'), 'forgejo', 'https://git.test', 104, 'prof'),
       ((select id from fx where name = 'u5'), 'forgejo', 'https://other.test', 105, 'erin');
insert into public.git_accounts (user_id, provider, instance_url) values ((select id from fx where name = 'u2'), 'forgejo', 'https://git.test');

create or replace function pg_temp.assignment(p_class text, p_slug text, p_provider text, p_release timestamptz,
  p_group public.assignment_group_mode default 'individual', p_mode public.assignment_repo_mode default 'template_only_staff',
  p_template text default 'staff/handout') returns bigint language sql as $$
  with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls(p_class)) returning id)
  insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, repo_mode, template_repo,
                                  git_provider, self_review_setting_id)
  select pg_temp.cls(p_class), p_slug, p_slug, now() + interval '7 days', p_release, p_group, p_mode, p_template, p_provider, s.id
  from s returning id
$$;
create temp table fx_a(name text primary key, id bigint);
insert into fx_a values
  ('released', pg_temp.assignment('orgless', 'hw1', 'forgejo', now() - interval '1 hour')),
  ('named', pg_temp.assignment('named', 'hw1', 'forgejo', now() - interval '1 hour')),
  ('future', pg_temp.assignment('orgless', 'hw2', 'forgejo', now() + interval '1 day')),
  ('github', pg_temp.assignment('named', 'hw3', 'github', now() - interval '1 hour')),
  ('groups', pg_temp.assignment('orgless', 'hw4', 'forgejo', now() - interval '1 hour', 'groups')),
  ('forks', pg_temp.assignment('orgless', 'hw5', 'forgejo', now() - interval '1 hour', 'individual', 'template_with_student_forks')),
  ('untemplated', pg_temp.assignment('orgless', 'hw6', 'forgejo', now() - interval '1 hour', 'individual', 'template_only_staff', null));

create temp table needed as select * from public.forgejo_repos_needed('https://git.test', 100)
  where class_id in (select id from fx_class);

-- 1, 2
select pg_temp.check('1 the student with a login is listed for the released assignment',
  exists (select 1 from needed where assignment_id = (select id from fx_a where name = 'released')
          and profile_id = pg_temp.priv('u1', 'orgless') and login = 'alex' and name = 'hw1-alex'
          and template_repo = 'staff/handout'));
select pg_temp.check('2a with no forgejo_org the org is the class slug',
  (select owner from needed where assignment_id = (select id from fx_a where name = 'released')) =
  (select slug from fx_class where name = 'orgless'));
select pg_temp.check('2b otherwise it is forgejo_org',
  (select owner from needed where assignment_id = (select id from fx_a where name = 'named')) = 'cs-forgejo');

-- 3
select pg_temp.check('3a only u1 is listed: no login, disabled, staff and another instance are not',
  (select array_agg(distinct login) from needed) = array['alex'], (select string_agg(login, ',') from needed));
select pg_temp.check('3b future, GitHub, group, fork-mode and untemplated assignments are not listed',
  not exists (select 1 from needed where assignment_id in
    (select id from fx_a where name in ('future', 'github', 'groups', 'forks', 'untemplated'))));
update public.classes set features = '[]' where id = pg_temp.cls('named');
select pg_temp.check('3c turning the flag off takes the class off the list',
  not exists (select 1 from public.forgejo_repos_needed('https://git.test', 100) where class_id = pg_temp.cls('named')));

-- 4
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider, is_github_ready)
values ((select id from fx_a where name = 'released'), pg_temp.cls('orgless'), pg_temp.priv('u1', 'orgless'),
        'repos-a/hw1-alex-' || left(gen_random_uuid()::text, 8), 'forgejo', false);
select pg_temp.check('4a a row that is not ready keeps the student listed',
  exists (select 1 from public.forgejo_repos_needed('https://git.test', 100)
          where assignment_id = (select id from fx_a where name = 'released')));
update public.repositories set is_github_ready = true where assignment_id = (select id from fx_a where name = 'released');
select pg_temp.check('4b a ready row takes the student off the list',
  not exists (select 1 from public.forgejo_repos_needed('https://git.test', 100)
              where assignment_id = (select id from fx_a where name = 'released')));

-- 5
create temp table k(kicks bigint, github bigint);
create or replace function pg_temp.github_creates() returns bigint language sql as $$
  select count(*) from public.api_gateway_calls where method = 'create_repo' and class_id in (select id from fx_class)
$$;
insert into k select pg_temp.kicks(), pg_temp.github_creates();
-- The assignments trigger releases it: release_date moves from the future into the past.
update public.assignments set release_date = now() - interval '2 minutes' where id = (select id from fx_a where name = 'future');
select pg_temp.check('5a releasing a Forgejo assignment in a class with no github_org kicks once',
  pg_temp.kicks() = (select kicks from k) + 1, 'kicks: ' || (pg_temp.kicks() - (select kicks from k)));
select pg_temp.check('5b and enqueues no GitHub repo', pg_temp.github_creates() = (select github from k));
update k set kicks = pg_temp.kicks();
select public.create_all_repos_for_assignment(pg_temp.cls('orgless'), (select id from fx_a where name = 'released'));
select pg_temp.check('5c calling create_all_repos_for_assignment directly kicks too', pg_temp.kicks() = (select kicks from k) + 1);
update k set kicks = pg_temp.kicks();
select public.create_all_repos_for_assignment(pg_temp.cls('named'), (select id from fx_a where name = 'github'));
select pg_temp.check('5d a GitHub assignment does not kick', pg_temp.kicks() = (select kicks from k));

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_repos checks failed'; end if; end $$;

rollback;
