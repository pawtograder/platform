-- Proof harness for 20261112120000_git_accounts.sql (#1092).
--
-- Makes its own fixtures, so it runs on an unseeded database too. Run from the repo root against
-- local Supabase; it all happens in one transaction that ends in ROLLBACK:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f tests/manual/git_accounts.sql
--
-- Each check prints PASS/FAIL, then a failure count. Scenarios:
--   1. who needs an account: an enabled student and a grader in a cloud-workspaces class do; a student
--      in a class without the flag, a disabled student, and a class with a malformed features value don't
--   2. claiming: the first claim wins, an immediate second claim loses, and a claim in flight hides
--      the user from forgejo_accounts_needed
--   3. a finished account is never needed or claimed again
--   4. a claim older than the stale window is needed again and can be taken over, after anyone never tried
--   5. reads: a user sees their own row, staff of the user's class see it, anyone else sees nothing;
--      nobody can write from the browser
--   6. only service_role can call the two functions
\set ON_ERROR_STOP on
\timing off
begin;

create temp table t_result(name text, ok boolean, detail text);
grant all on t_result to authenticated;

create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into t_result values (p_name, coalesce(p_ok, false), p_detail) $$;
grant execute on function pg_temp.check(text, boolean, text) to authenticated;

create or replace function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create temp table fx(name text primary key, id uuid);
grant select on fx to authenticated;
-- newcomer's id sorts after everyone's, so 4e only passes when ordering puts never-tried users first.
insert into fx values
  ('student', gen_random_uuid()), ('grader', gen_random_uuid()), ('other_student', gen_random_uuid()),
  ('disabled_student', gen_random_uuid()), ('malformed_student', gen_random_uuid()),
  ('newcomer', ('ffffffff' || substr(gen_random_uuid()::text, 9))::uuid);
insert into auth.users (id, email, aud, role)
select id, name || '-' || left(id::text, 8) || '@git-accounts.test', 'authenticated', 'authenticated' from fx;

create temp table fx_class(name text primary key, id bigint);
grant select on fx_class to authenticated;
with c as (
  insert into public.classes (name, slug, features)
  values ('CW flagged', 'cw-flagged-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":true}]'),
         ('CW unflagged', 'cw-unflagged-' || left(gen_random_uuid()::text, 8), '[{"name":"cloud-workspaces","enabled":false}]'),
         ('CW malformed', 'cw-malformed-' || left(gen_random_uuid()::text, 8), '{"cloud-workspaces":true}')
  returning id, name
)
insert into fx_class select name, id from c;

create or replace function pg_temp.enroll(p_user text, p_class text, p_role public.app_role, p_disabled boolean default false)
returns void language plpgsql as $$
declare
  v_uid uuid := (select id from fx where name = p_user);
  v_cid bigint := (select id from fx_class where name = p_class);
  v_priv uuid; v_pub uuid;
begin
  insert into public.profiles (class_id, is_private_profile, name) values (v_cid, true, p_user) returning id into v_priv;
  insert into public.profiles (class_id, is_private_profile, name) values (v_cid, false, p_user || ' (public)') returning id into v_pub;
  insert into public.user_roles (user_id, class_id, role, private_profile_id, public_profile_id, disabled)
  values (v_uid, v_cid, p_role, v_priv, v_pub, p_disabled);
end $$;

select pg_temp.enroll('student', 'CW flagged', 'student');
select pg_temp.enroll('grader', 'CW flagged', 'grader');
select pg_temp.enroll('newcomer', 'CW flagged', 'student');
select pg_temp.enroll('other_student', 'CW unflagged', 'student');
select pg_temp.enroll('disabled_student', 'CW flagged', 'student', true);
select pg_temp.enroll('malformed_student', 'CW malformed', 'student');

\set inst '''https://forgejo.git-accounts.test'''

create or replace function pg_temp.needed(p_user text) returns boolean language sql as $$
  select exists (
    select 1 from public.forgejo_accounts_needed('https://forgejo.git-accounts.test', 10, 1000) n
    where n.user_id = (select id from fx where name = p_user))
$$;
create or replace function pg_temp.claim(p_user text) returns boolean language sql as $$
  select public.claim_git_account((select id from fx where name = p_user), 'https://forgejo.git-accounts.test', 10)
$$;

-- 1
select pg_temp.check('1a enabled student in flagged class needs an account', pg_temp.needed('student'));
select pg_temp.check('1b grader in flagged class needs an account', pg_temp.needed('grader'));
select pg_temp.check('1c student in unflagged class does not', not pg_temp.needed('other_student'));
select pg_temp.check('1d disabled student does not', not pg_temp.needed('disabled_student'));
select pg_temp.check('1e malformed features value counts as off', not pg_temp.needed('malformed_student'));
select pg_temp.check('1f needed returns the email',
  (select email from public.forgejo_accounts_needed(:inst, 10, 1000) where user_id = (select id from fx where name = 'student'))
    like 'student-%@git-accounts.test');

-- 2
select pg_temp.check('2a first claim wins', pg_temp.claim('student'));
select pg_temp.check('2b immediate second claim loses', not pg_temp.claim('student'));
select pg_temp.check('2c a claim in flight is not needed', not pg_temp.needed('student'));
select pg_temp.check('2d one row per user', (select count(*) = 1 from public.git_accounts where user_id = (select id from fx where name = 'student')));

-- 3
update public.git_accounts set remote_user_id = 4242, login = 'student'
where user_id = (select id from fx where name = 'student');
update public.git_accounts set claimed_at = now() - interval '1 hour'
where user_id = (select id from fx where name = 'student');
select pg_temp.check('3a a finished account is not needed, even past the stale window', not pg_temp.needed('student'));
select pg_temp.check('3b a finished account cannot be claimed', not pg_temp.claim('student'));
select pg_temp.check('3c the finished row is untouched',
  (select remote_user_id = 4242 and login = 'student' from public.git_accounts where user_id = (select id from fx where name = 'student')));

-- 4
select pg_temp.claim('grader');
update public.git_accounts set claimed_at = now() - interval '20 minutes'
where user_id = (select id from fx where name = 'grader');
select pg_temp.check('4a a stale claim is needed again', pg_temp.needed('grader'));
select pg_temp.check('4b a stale claim can be taken over', pg_temp.claim('grader'));
select pg_temp.check('4c taking over refreshes claimed_at',
  (select claimed_at > now() - interval '1 minute' from public.git_accounts where user_id = (select id from fx where name = 'grader')));
select pg_temp.check('4d still one row', (select count(*) = 1 from public.git_accounts where user_id = (select id from fx where name = 'grader')));
update public.git_accounts set claimed_at = now() - interval '30 minutes'
where user_id = (select id from fx where name = 'grader');
select pg_temp.check('4e a user never tried is listed before one whose claim went stale',
  (select min(n.ord) filter (where n.user_id = (select id from fx where name = 'newcomer'))
        < min(n.ord) filter (where n.user_id = (select id from fx where name = 'grader'))
   from public.forgejo_accounts_needed(:inst, 10, 1000) with ordinality as n(user_id, email, name, ord)));
update public.git_accounts set claimed_at = now()
where user_id = (select id from fx where name = 'grader');

-- 5
select pg_temp.as_user((select id from fx where name = 'student'));
select pg_temp.check('5a a user reads their own row',
  (select count(*) = 1 from public.git_accounts where user_id = (select id from fx where name = 'student')));
select pg_temp.check('5b a student does not read classmates'' rows',
  (select count(*) = 0 from public.git_accounts where user_id = (select id from fx where name = 'grader')));
do $$ begin
  insert into public.git_accounts (user_id, provider, instance_url) values ((select id from fx where name = 'student'), 'forgejo', 'https://evil.test');
  perform pg_temp.check('5c a user cannot insert', false, 'insert succeeded');
exception when insufficient_privilege then perform pg_temp.check('5c a user cannot insert', true);
end $$;
update public.git_accounts set login = 'hijacked' where user_id = (select id from fx where name = 'student');
reset role;
select pg_temp.check('5d a user cannot update their row',
  (select login = 'student' from public.git_accounts where user_id = (select id from fx where name = 'student')));

select pg_temp.as_user((select id from fx where name = 'grader'));
select pg_temp.check('5e staff read rows of people in their class',
  (select count(*) = 1 from public.git_accounts where user_id = (select id from fx where name = 'student')));
reset role;

select pg_temp.as_user((select id from fx where name = 'other_student'));
select pg_temp.check('5f a user in another class reads nothing', (select count(*) = 0 from public.git_accounts));
reset role;

-- 6
select pg_temp.as_user((select id from fx where name = 'grader'));
do $$ begin
  perform public.forgejo_accounts_needed('https://forgejo.git-accounts.test', 10, 10);
  perform pg_temp.check('6a authenticated cannot list who needs accounts', false, 'call succeeded');
exception when insufficient_privilege then perform pg_temp.check('6a authenticated cannot list who needs accounts', true);
end $$;
do $$ begin
  perform public.claim_git_account((select id from fx where name = 'grader'), 'https://evil.test', 10);
  perform pg_temp.check('6b authenticated cannot claim', false, 'call succeeded');
exception when insufficient_privilege then perform pg_temp.check('6b authenticated cannot claim', true);
end $$;
reset role;

select case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(detail, '') as detail from t_result order by name;
select count(*) filter (where not ok) as failures, count(*) as checks from t_result;
-- With ON_ERROR_STOP, a failed check makes `psql -f` exit nonzero.
do $$ begin if exists (select 1 from t_result where not ok) then raise exception 'git_accounts checks failed'; end if; end $$;

rollback;
