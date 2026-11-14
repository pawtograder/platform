-- Proof harness for 20261112120400_forgejo_group_repos.sql (#1236).
--
-- Makes its own fixtures and ends in ROLLBACK. Run it in one transaction with the migration if the
-- migration isn't applied yet:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/manual/forgejo_group_repos.sql
--
-- Scenarios:
--   1. a released Forgejo group assignment lists each group once, as <slug>-group-<sanitized name>,
--      with every member's login, and says whether every member has one
--   2. a ready group repo takes the group off the list
--   3. adding a member marks the group's Forgejo repo not ready and kicks forgejo-reconciler once;
--      group changes on a Forgejo assignment no longer reach the GitHub path, which raised for a class
--      with no github_org
--   4. group_config 'both': a student in a group gets no individual repo; one in no group does
--   5. save_forgejo_group_repo marks a repo ready only when every current member was granted, and
--      creates the row the first time; the pass's first save claims the name, so a second group can't
--   6. publish and copy don't re-permission a GitHub repo that shares a Forgejo group repo's name,
--      once the class has a GitHub org; copy into a Forgejo assignment needs no GitHub org
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;
create or replace function pg_temp.kicks() returns bigint language sql as $$
  select count(*) from net.http_request_queue where url like '%/functions/v1/forgejo-reconciler'
$$;

create temp table fx_class(id bigint);
with c as (
  insert into public.classes (name, slug, features, forgejo_org)
  values ('groups', 'grp-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]', 'grp-org')
  returning id
)
insert into fx_class select id from c;
create or replace function pg_temp.cls() returns bigint language sql as $$ select id from fx_class $$;

-- u1, u2: students with Forgejo logins. u3: a student whose account is still being created.
-- u4: a student with a login, added to a group later. u5: a student in no group.
create temp table fx(name text primary key, user_id uuid, priv uuid, pub uuid);
insert into fx select 'u' || g, gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from generate_series(1, 5) g;
insert into auth.users (id, email, aud, role)
select user_id, name || '-' || left(user_id::text, 8) || '@groups.test', 'authenticated', 'authenticated' from fx;
insert into public.profiles (id, class_id, is_private_profile, name)
select priv, pg_temp.cls(), true, name from fx union all select pub, pg_temp.cls(), false, name || ' (public)' from fx;
insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
select user_id, pg_temp.cls(), 'student', priv, pub from fx;
insert into public.git_accounts (user_id, provider, instance_url, remote_user_id, login)
select user_id, 'forgejo', 'https://git.test', 200 + row_number() over (order by name), 'login-' || name
from fx where name in ('u1', 'u2', 'u4', 'u5');
insert into public.git_accounts (user_id, provider, instance_url) select user_id, 'forgejo', 'https://git.test' from fx where name = 'u3';
create or replace function pg_temp.priv(n text) returns uuid language sql as $$ select priv from fx where name = n $$;

create or replace function pg_temp.assignment(p_slug text, p_group public.assignment_group_mode) returns bigint language sql as $$
  with s as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id)
  insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, repo_mode, template_repo,
                                  git_provider, self_review_setting_id)
  select pg_temp.cls(), p_slug, p_slug, now() + interval '7 days', now() + interval '1 day', p_group,
         'template_only_staff', 'staff/handout', 'forgejo', s.id
  from s returning id
$$;
create temp table fx_a(name text primary key, id bigint);
insert into fx_a values ('groups', pg_temp.assignment('proj', 'groups')), ('both', pg_temp.assignment('lab', 'both'));
-- Released after the fixtures exist, so the release path's kick isn't counted below.
update public.assignments set release_date = now() - interval '1 hour' where id in (select id from fx_a);
create or replace function pg_temp.a(n text) returns bigint language sql as $$ select id from fx_a where name = n $$;

create temp table fx_g(name text primary key, id bigint);
create temp table fx_gv(n text, a text, gname text);
insert into fx_gv values ('complete', 'groups', 'Team One!'), ('waiting', 'groups', 'Team Two'), ('lab', 'both', 'Lab Pair');
with g as (
  insert into public.assignment_groups (assignment_id, class_id, name)
  select pg_temp.a(a), pg_temp.cls(), gname from fx_gv
  returning id, name
)
insert into fx_g select v.n, g.id from g join fx_gv v on v.gname = g.name;
create or replace function pg_temp.g(n text) returns bigint language sql as $$ select id from fx_g where name = n $$;
create or replace function pg_temp.join(p_group text, p_user text, p_assignment text) returns void language sql as $$
  insert into public.assignment_groups_members (assignment_group_id, assignment_id, class_id, profile_id, added_by)
  values (pg_temp.g(p_group), pg_temp.a(p_assignment), pg_temp.cls(), pg_temp.priv(p_user), pg_temp.priv(p_user))
$$;
select pg_temp.join('complete', 'u1', 'groups'), pg_temp.join('complete', 'u2', 'groups'),
       pg_temp.join('waiting', 'u3', 'groups'), pg_temp.join('lab', 'u1', 'both');

create temp table needed as select * from public.forgejo_group_repos_needed('https://git.test', 100)
  where class_id = pg_temp.cls();

-- 1
select pg_temp.check('1a each group with members is listed once', (select count(*) from needed) = 3,
  (select string_agg(name, ', ') from needed));
select pg_temp.check('1b the repo is <slug>-group-<sanitized name> in the class org',
  exists (select 1 from needed where assignment_group_id = pg_temp.g('complete')
          and owner = 'grp-org' and name = 'proj-group-Team-One'));
select pg_temp.check('1c it carries every member''s login and knows they all have one',
  exists (select 1 from needed where assignment_group_id = pg_temp.g('complete')
          and logins = array['login-u1', 'login-u2'] and all_members_have_logins));
select pg_temp.check('1d a member still waiting for an account makes the group incomplete',
  exists (select 1 from needed where assignment_group_id = pg_temp.g('waiting')
          and logins = '{}' and not all_members_have_logins));

-- Separate statements: within one query Postgres can reuse a subquery's rows instead of calling again.
create temp table orders(o bigint[]);
do $$ begin
  for i in 1..20 loop
    insert into orders select array_agg(assignment_group_id)
    from public.forgejo_group_repos_needed('https://git.test', 100) where class_id = pg_temp.cls();
  end loop;
end $$;
select pg_temp.check('1e the list is sampled, not in a fixed order', (select count(distinct o) from orders) > 1);

-- 2
insert into public.repositories (assignment_id, class_id, assignment_group_id, repository, git_provider, is_github_ready)
values (pg_temp.a('groups'), pg_temp.cls(), pg_temp.g('complete'), 'grp-org/proj-group-Team-One', 'forgejo', true);
select pg_temp.check('2 a ready group repo takes the group off the list',
  not exists (select 1 from public.forgejo_group_repos_needed('https://git.test', 100)
              where assignment_group_id = pg_temp.g('complete')));

-- 3
create temp table k(v bigint); insert into k select pg_temp.kicks();
select pg_temp.join('complete', 'u4', 'groups');
select pg_temp.check('3a adding a member marks the group repo not ready',
  not (select is_github_ready from public.repositories where assignment_group_id = pg_temp.g('complete')));
select pg_temp.check('3b and lists the group again with the new member',
  exists (select 1 from public.forgejo_group_repos_needed('https://git.test', 100)
          where assignment_group_id = pg_temp.g('complete') and 'login-u4' = any (logins)));
select pg_temp.check('3c and kicks the reconciler once', pg_temp.kicks() = (select v from k) + 1,
  'kicks: ' || (pg_temp.kicks() - (select v from k)));
update k set v = pg_temp.kicks();
select pg_temp.join('waiting', 'u5', 'groups');
select pg_temp.check('3d adding a member to a group with no repo yet kicks too, so it gets one now',
  pg_temp.kicks() = (select v from k) + 1);

-- 4
select pg_temp.check('4a in a ''both'' assignment, a grouped student gets no individual repo',
  not exists (select 1 from public.forgejo_repos_needed('https://git.test', 100)
              where assignment_id = pg_temp.a('both') and profile_id = pg_temp.priv('u1')));
select pg_temp.check('4b and a student in no group does',
  exists (select 1 from public.forgejo_repos_needed('https://git.test', 100)
          where assignment_id = pg_temp.a('both') and profile_id = pg_temp.priv('u2')));

-- 5: 'complete' now has u1, u2 and u4. Each save runs on its own: a check written as `save() and
-- (select ...)` can read the row before the save.
create temp table saved(k text primary key, ready boolean);
insert into saved select 'partial', public.save_forgejo_group_repo(pg_temp.g('complete'),
  'grp-org/proj-group-Team-One', 'https://git.test', array['login-u1', 'login-u2']);
select pg_temp.check('5a a pass that granted only the members it read leaves the repo not ready',
  not (select ready from saved where k = 'partial')
  and not (select is_github_ready from public.repositories where assignment_group_id = pg_temp.g('complete')));
insert into saved select 'all', public.save_forgejo_group_repo(pg_temp.g('complete'),
  'grp-org/proj-group-Team-One', 'https://git.test', array['login-u1', 'login-u2', 'login-u4']);
select pg_temp.check('5b granting every member makes it ready, on the same row',
  (select ready from saved where k = 'all')
  and (select count(*) = 1 and bool_and(is_github_ready) from public.repositories
       where assignment_group_id = pg_temp.g('complete')));
insert into saved select 'first', public.save_forgejo_group_repo(pg_temp.g('lab'),
  'grp-org/lab-group-Lab-Pair', 'https://git.test', array['login-u1']);
select pg_temp.check('5c a first save creates the group''s Forgejo row',
  (select ready from saved where k = 'first')
  and exists (select 1 from public.repositories where assignment_group_id = pg_temp.g('lab')
              and git_provider = 'forgejo' and profile_id is null and is_github_ready));
insert into saved select 'no-login', public.save_forgejo_group_repo(pg_temp.g('waiting'),
  'grp-org/proj-group-Team-Two', 'https://git.test', array['login-u5']);
select pg_temp.check('5d a member without a login keeps it not ready', not (select ready from saved where k = 'no-login'));
do $$ begin
  perform public.save_forgejo_group_repo(pg_temp.g('waiting'), 'grp-org/proj-group-Team-One', 'https://git.test', '{}');
  perform pg_temp.check('5e a pass can''t claim a name another group holds', false, 'save succeeded');
exception when unique_violation then
  perform pg_temp.check('5e a pass can''t claim a name another group holds', true);
end $$;
select public.save_forgejo_group_repo(pg_temp.g('complete'), 'grp-org/proj-group-Team-One', 'https://git.test', '{}');
select pg_temp.check('5f claiming a name that is already this group''s keeps its readiness',
  (select is_github_ready from public.repositories where assignment_group_id = pg_temp.g('complete')));

-- 6
update public.classes set github_org = 'gh-org' where id = pg_temp.cls();
insert into fx select 'teacher', gen_random_uuid(), gen_random_uuid(), gen_random_uuid();
insert into auth.users (id, email, aud, role)
select user_id, 'teacher-' || left(user_id::text, 8) || '@groups.test', 'authenticated', 'authenticated'
from fx where name = 'teacher';
insert into public.profiles (id, class_id, is_private_profile, name)
select priv, pg_temp.cls(), true, name from fx where name = 'teacher'
union all select pub, pg_temp.cls(), false, name || ' (public)' from fx where name = 'teacher';
insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id)
select user_id, pg_temp.cls(), 'instructor', priv, pub from fx where name = 'teacher';
-- A target group that already has a Forgejo repo, so copy's permission sync reaches it.
with g as (
  insert into public.assignment_groups (assignment_id, class_id, name)
  values (pg_temp.a('both'), pg_temp.cls(), 'Team One!') returning id
)
insert into fx_g select 'lab-one', id from g;
insert into public.repositories (assignment_id, class_id, assignment_group_id, repository, git_provider, is_github_ready)
values (pg_temp.a('both'), pg_temp.cls(), pg_temp.g('lab-one'), 'grp-org/lab-group-Team-One', 'forgejo', true);
-- GitHub repos, on a GitHub assignment, named like the Forgejo group repos under the class's GitHub org.
-- Released in the future, so inserting it doesn't start repo creation.
with st as (insert into public.assignment_self_review_settings (class_id) values (pg_temp.cls()) returning id),
     a as (
  insert into public.assignments (class_id, title, slug, due_date, release_date, group_config, git_provider,
                                  self_review_setting_id)
  select pg_temp.cls(), 'gh', 'gh', now() + interval '14 days', now() + interval '7 days', 'individual', 'github', st.id
  from st returning id
)
insert into fx_a select 'gh', id from a;
insert into public.repositories (assignment_id, class_id, profile_id, repository, git_provider)
values (pg_temp.a('gh'), pg_temp.cls(), pg_temp.priv('u1'), 'gh-org/proj-group-Team-One', 'github'),
       (pg_temp.a('gh'), pg_temp.cls(), pg_temp.priv('u2'), 'gh-org/proj-group-Team-Two', 'github'),
       (pg_temp.a('gh'), pg_temp.cls(), pg_temp.priv('u3'), 'gh-org/lab-group-Lab-Pair', 'github'),
       (pg_temp.a('gh'), pg_temp.cls(), pg_temp.priv('u5'), 'gh-org/lab-group-Team-One', 'github');
create or replace function pg_temp.github_calls() returns bigint language sql as $$
  select count(*) from public.api_gateway_calls
  where class_id = pg_temp.cls() and method in ('sync_repo_permissions', 'archive_repo_and_lock')
$$;
create temp table calls_before(v bigint); insert into calls_before select pg_temp.github_calls();
select set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true)
from fx where name = 'teacher';
-- Nothing here dissolves a group: deleting a Forgejo repository row raises (20261020150000), so a
-- publish or copy that would dissolve a Forgejo group with a repo fails as a whole.
-- u4 leaves 'complete', whose repo the GitHub path would re-permission.
create temp table published as select public.publish_assignment_group_changes(pg_temp.cls(), pg_temp.a('groups'), '[]',
  jsonb_build_array(
    jsonb_build_object('profile_id', pg_temp.priv('u4'), 'old_group_id', pg_temp.g('complete'), 'new_group_id', null)
  )) as r;
select pg_temp.check('6a publish drops a member from a Forgejo group without GitHub calls',
  (select (r->>'syncs_enqueued')::int = 0 and jsonb_array_length(r->'errors') = 0 from published)
  and pg_temp.github_calls() = (select v from calls_before),
  (select r::text from published) || ' calls: ' || (pg_temp.github_calls() - (select v from calls_before)));
-- The source gets a 'Lab Pair' too, so copy keeps both target groups, which have Forgejo repos.
with g as (
  insert into public.assignment_groups (assignment_id, class_id, name)
  values (pg_temp.a('groups'), pg_temp.cls(), 'Lab Pair') returning id
)
insert into fx_g select 'src-lab', id from g;
select pg_temp.join('src-lab', 'u4', 'groups');
create temp table copied as select public.copy_groups_from_assignment(pg_temp.cls(), pg_temp.a('groups'), pg_temp.a('both')) as r;
select pg_temp.check('6b copy into groups with Forgejo repos makes no GitHub calls',
  (select (r->>'groups_deleted')::int = 0 from copied)
  and pg_temp.github_calls() = (select v from calls_before),
  (select r::text from copied) || ' calls: ' || (pg_temp.github_calls() - (select v from calls_before)));
update public.classes set github_org = null where id = pg_temp.cls();
do $$ begin
  perform public.copy_groups_from_assignment(pg_temp.cls(), pg_temp.a('groups'), pg_temp.a('both'));
  perform pg_temp.check('6c copy into a released Forgejo assignment works in a class with no GitHub org', true);
exception when others then
  perform pg_temp.check('6c copy into a released Forgejo assignment works in a class with no GitHub org', false, sqlerrm);
end $$;
select set_config('request.jwt.claims', '', true);

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'forgejo_group_repos checks failed'; end if; end $$;

rollback;
