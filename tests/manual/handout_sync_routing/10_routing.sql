-- Proof harness for 20261109120000_handout_sync_queue_and_routing.sql (build plan WP4).
--
-- Run it through run.sh in this directory, which points it at a database you name and refuses the
-- shared local stack. Everything happens in one transaction that ends in ROLLBACK, and it builds
-- its own fixtures, so it needs a migrated database and nothing else (no seed).
--
-- THE BASELINE IS THE OLD FUNCTION ITSELF. Before anything else the script loads
-- 20260915120000_dedupe_queued_repository_syncs.sql, the queue_repository_syncs this migration
-- replaces, presses Sync once and keeps the message it sent. Then it loads the new migration on top
-- and compares every message against that one. "The REST message is unchanged" is therefore
-- checked against what production sends today, not against a literal copied into this file.
--
-- Checks are recorded rather than raised, so one failure does not hide the rest; run.sh turns any
-- FAIL row into a non-zero exit.
\set ON_ERROR_STOP on
\pset pager off
set client_min_messages = warning;

begin;

-- Triggers on classes and assignments warn about a missing vercel secret on every insert.
set local client_min_messages = error;

create temp table t_result (seq serial, name text, ok boolean, expected text, actual text);

create or replace function pg_temp.expect(p_name text, p_expected text, p_actual text) returns void
language plpgsql as $$
begin
  insert into t_result(name, ok, expected, actual)
  values (p_name, p_expected is not distinct from p_actual, p_expected, p_actual);
end $$;

-- Fixtures -------------------------------------------------------------------------------------
-- One class, one instructor, one assignment whose handout moved from sha-v1 to sha-v2, and six
-- GitHub-ready repositories that are still on sha-v1.
insert into classes (id, name, slug, term, github_org) values (910001, 'WP4 class', 'wp4-910001', 202610, 'wp4-org');
insert into auth.users (id, email, aud, role, instance_id)
values ('00000000-0000-0000-0000-0000000c4001', 'wp4-instr@example.com', 'authenticated', 'authenticated',
        '00000000-0000-0000-0000-000000000000');
insert into users (user_id, email, name) values ('00000000-0000-0000-0000-0000000c4001', 'wp4-instr@example.com', 'WP4 Instr')
on conflict (user_id) do nothing;
insert into user_privileges (user_id, class_id, role) values ('00000000-0000-0000-0000-0000000c4001', 910001, 'instructor')
on conflict do nothing;
insert into assignment_self_review_settings (id, class_id) values (910001, 910001);
insert into assignments (id, class_id, title, slug, due_date, group_config, self_review_setting_id,
                         template_repo, latest_template_sha, release_date)
values (910001, 910001, 'WP4 A', 'wp4-a', now() + interval '7 days', 'individual', 910001,
        'wp4-org/handout', 'sha-v2', now() - interval '1 day');
insert into repositories (id, assignment_id, class_id, repository, is_github_ready, synced_handout_sha, synced_repo_sha)
select 910000 + g, 910001, 910001, 'wp4-org/stu-' || g, true, 'sha-v1', 'repo-head-' || g
from generate_series(1, 6) g;

-- Press Sync as the instructor, the way PostgREST would call it, and return the RPC's answer.
create or replace function pg_temp.press(p_ids bigint[], p_force boolean default false) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-0000000c4001', 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  v := public.queue_repository_syncs(p_ids, p_force);
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- Empty every queue a sync can be on and put the repositories back on sha-v1 with nothing desired.
create or replace function pg_temp.reset() returns void language plpgsql as $$
begin
  perform pgmq.purge_queue('async_calls');
  perform pgmq.purge_queue('async_calls_low_priority');
  perform pgmq.purge_queue('handout_sync');
  update repositories set desired_handout_sha = null, synced_handout_sha = 'sha-v1',
                          synced_repo_sha = 'repo-head-' || (id - 910000)
   where class_id = 910001;
end $$;

-- Sync messages per queue, for one repository.
create or replace function pg_temp.n(p_queue text, p_repo bigint) returns text language plpgsql as $$
declare
  v bigint;
begin
  execute format('select count(*) from pgmq.%I where message->>''method'' = ''sync_repo_to_handout''
                    and message->''args''->>''repository_id'' = $1', 'q_' || p_queue)
    into v using p_repo::text;
  return v::text;
end $$;

create or replace function pg_temp.msg(p_queue text, p_repo bigint) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  execute format('select message from pgmq.%I where message->''args''->>''repository_id'' = $1
                   order by msg_id limit 1', 'q_' || p_queue)
    into v using p_repo::text;
  return v;
end $$;

-- A message as the old function built it, for repository p_repo, from the baseline taken below.
-- Only the per-repository fields differ between repositories.
create temp table t_baseline (message jsonb);
create or replace function pg_temp.expected(p_repo bigint) returns jsonb language sql as $$
  select message
         || jsonb_build_object('repo_id', p_repo)
         || jsonb_build_object('args', (message->'args')
              || jsonb_build_object('repository_id', p_repo, 'repository_full_name', 'wp4-org/stu-' || (p_repo - 910000)))
    from t_baseline
$$;

-- Baseline: the function this migration replaces --------------------------------------------
\echo '=== baseline: queue_repository_syncs as of 20260915120000 ==='
\i supabase/migrations/20260915120000_dedupe_queued_repository_syncs.sql
-- That revision predates handout_sync, so its RPC answer and message are the reference.
select pg_temp.reset();
select pg_temp.press(array[910001]::bigint[]) as baseline_answer;
insert into t_baseline select message from pgmq.q_async_calls;
select pg_temp.expect('baseline: old function sent one message', '1', (select count(*)::text from t_baseline));

\echo '=== applying 20261109120000 ==='
\i supabase/migrations/20261109120000_handout_sync_queue_and_routing.sql
set local client_min_messages = error;

-- Routing ---------------------------------------------------------------------------------------
\echo '=== 1. engine rest (the seeded row): unchanged ==='
do $$
declare
  r jsonb;
begin
  perform pg_temp.expect('1 seeded row', '{"engine": "rest", "shadow": false}',
    (select value::text from system_settings where key = 'handout_sync_engine'));
  perform pg_temp.reset();
  r := pg_temp.press(array[910001]::bigint[]);
  perform pg_temp.expect('1 rest: queued_count', '1', r->>'queued_count');
  perform pg_temp.expect('1 rest: async_calls holds the message', '1', pg_temp.n('async_calls', 910001));
  perform pg_temp.expect('1 rest: handout_sync is empty', '0', pg_temp.n('handout_sync', 910001));
  perform pg_temp.expect('1 rest: message identical to the old function''s',
    pg_temp.expected(910001)::text, pg_temp.msg('async_calls', 910001)::text);
  perform pg_temp.expect('1 rest: RPC answer has the same keys as the old one',
    'error_count,errors,queued_count,skipped_count,skipped_in_flight_count,success',
    (select string_agg(k, ',' order by k) from jsonb_object_keys(r) k));
  perform pg_temp.expect('1 rest: desired_handout_sha raised', 'sha-v2',
    (select desired_handout_sha from repositories where id = 910001));
end $$;

\echo '=== 2. engine git: handout_sync only ==='
do $$
declare
  r jsonb;
begin
  update system_settings set value = '{"engine": "git", "shadow": false}' where key = 'handout_sync_engine';
  perform pg_temp.reset();
  r := pg_temp.press(array[910001, 910002]::bigint[]);
  perform pg_temp.expect('2 git: queued_count', '2', r->>'queued_count');
  perform pg_temp.expect('2 git: async_calls empty (repo 1)', '0', pg_temp.n('async_calls', 910001));
  perform pg_temp.expect('2 git: async_calls_low_priority empty (repo 1)', '0', pg_temp.n('async_calls_low_priority', 910001));
  perform pg_temp.expect('2 git: handout_sync holds repo 1', '1', pg_temp.n('handout_sync', 910001));
  perform pg_temp.expect('2 git: handout_sync holds repo 2', '1', pg_temp.n('handout_sync', 910002));
  perform pg_temp.expect('2 git: message identical to the REST envelope',
    pg_temp.expected(910001)::text, pg_temp.msg('handout_sync', 910001)::text);

  -- shadow is meaningless with git routing: nothing to compare against, so no copy.
  update system_settings set value = '{"engine": "git", "shadow": true}' where key = 'handout_sync_engine';
  perform pg_temp.reset();
  r := pg_temp.press(array[910001]::bigint[]);
  perform pg_temp.expect('2 git+shadow: exactly one message in handout_sync', '1', pg_temp.n('handout_sync', 910001));
  perform pg_temp.expect('2 git+shadow: it is not a shadow copy', null, pg_temp.msg('handout_sync', 910001)->>'shadow');
  perform pg_temp.expect('2 git+shadow: async_calls empty', '0', pg_temp.n('async_calls', 910001));
end $$;

\echo '=== 3. engine rest + shadow: REST unchanged, marked copy in handout_sync ==='
do $$
declare
  r jsonb;
  v_shadow jsonb;
begin
  update system_settings set value = '{"engine": "rest", "shadow": true}' where key = 'handout_sync_engine';
  perform pg_temp.reset();
  r := pg_temp.press(array[910003]::bigint[]);
  perform pg_temp.expect('3 shadow: queued_count counts the sync once', '1', r->>'queued_count');
  perform pg_temp.expect('3 shadow: async_calls holds the REST message', '1', pg_temp.n('async_calls', 910003));
  perform pg_temp.expect('3 shadow: REST message identical to the old function''s',
    pg_temp.expected(910003)::text, pg_temp.msg('async_calls', 910003)::text);
  perform pg_temp.expect('3 shadow: handout_sync holds one copy', '1', pg_temp.n('handout_sync', 910003));
  v_shadow := pg_temp.msg('handout_sync', 910003);
  perform pg_temp.expect('3 shadow: copy is marked shadow: true', 'true', (v_shadow->'shadow')::text);
  perform pg_temp.expect('3 shadow: copy carries from_sha = synced_handout_sha at enqueue', 'sha-v1',
    v_shadow->'args'->>'from_sha');
  perform pg_temp.expect('3 shadow: copy carries synced_repo_sha at enqueue', 'repo-head-3',
    v_shadow->'args'->>'synced_repo_sha');
  perform pg_temp.expect('3 shadow: copy is the REST envelope plus exactly those two fields',
    pg_temp.expected(910003)::text,
    ((v_shadow - 'shadow') || jsonb_build_object('args', (v_shadow->'args') - 'synced_repo_sha'))::text);

  -- The inputs are frozen at enqueue: the REST job advancing the row does not reach the copy.
  update repositories set synced_handout_sha = 'sha-v2', synced_repo_sha = 'repo-after-rest' where id = 910003;
  perform pg_temp.expect('3 shadow: copy keeps the enqueue-time synced_repo_sha after the row moves', 'repo-head-3',
    pg_temp.msg('handout_sync', 910003)->'args'->>'synced_repo_sha');

  -- Dedupe ignores shadow copies. The REST job has finished (archived) and only the shadow copy
  -- is left; a forced press of the same revision must queue, not report "in flight".
  perform pgmq.archive('async_calls', (select msg_id from pgmq.q_async_calls
                                        where message->'args'->>'repository_id' = '910003'));
  r := pg_temp.press(array[910003]::bigint[], true);
  perform pg_temp.expect('3 dedupe ignores shadow: queued_count', '1', r->>'queued_count');
  perform pg_temp.expect('3 dedupe ignores shadow: skipped_in_flight_count', '0', r->>'skipped_in_flight_count');

  -- And with the REST message still queued, the same press is a duplicate and is refused, so the
  -- shadow filter has not turned the claim off.
  r := pg_temp.press(array[910003]::bigint[], true);
  perform pg_temp.expect('3 REST message still claims: skipped_in_flight_count', '1', r->>'skipped_in_flight_count');
  perform pg_temp.expect('3 REST message still claims: queued_count', '0', r->>'queued_count');
end $$;

\echo '=== 3b. a failed shadow send costs the shadow copy, not the sync ==='
do $$
declare
  r jsonb;
begin
  update system_settings set value = '{"engine": "rest", "shadow": true}' where key = 'handout_sync_engine';
  perform pg_temp.reset();
  -- Make every send to handout_sync fail.
  alter table pgmq.q_handout_sync rename to q_handout_sync_hidden;
  r := pg_temp.press(array[910004]::bigint[]);
  alter table pgmq.q_handout_sync_hidden rename to q_handout_sync;
  perform pg_temp.expect('3b shadow send failed: queued_count', '1', r->>'queued_count');
  perform pg_temp.expect('3b shadow send failed: error_count', '0', r->>'error_count');
  perform pg_temp.expect('3b shadow send failed: REST message sent', '1', pg_temp.n('async_calls', 910004));
  perform pg_temp.expect('3b shadow send failed: REST message identical',
    pg_temp.expected(910004)::text, pg_temp.msg('async_calls', 910004)::text);
end $$;

\echo '=== 4. missing or malformed setting: REST, no shadow ==='
do $$
declare
  v_case text;
  r jsonb;
begin
  foreach v_case in array array[
    '<missing>', 'null', '{}', '"git"', '["git"]', '{"engine": "GIT"}', '{"engine": ["git"]}',
    '{"engine": {"name": "git"}}', '{"engine": "git "}', '{"engine": null}', '{"shadow": "true"}',
    '{"engine": "rest", "shadow": 1}', '{"engine": "rest", "shadow": "yes"}', 'true', '42'
  ] loop
    delete from system_settings where key = 'handout_sync_engine';
    if v_case <> '<missing>' then
      insert into system_settings (key, value) values ('handout_sync_engine', v_case::jsonb);
    end if;
    perform pg_temp.reset();
    r := pg_temp.press(array[910005]::bigint[]);
    perform pg_temp.expect('4 ' || v_case || ': queued once', '1', r->>'queued_count');
    perform pg_temp.expect('4 ' || v_case || ': REST message in async_calls', '1', pg_temp.n('async_calls', 910005));
    perform pg_temp.expect('4 ' || v_case || ': nothing in handout_sync', '0', pg_temp.n('handout_sync', 910005));
    perform pg_temp.expect('4 ' || v_case || ': message identical',
      pg_temp.expected(910005)::text, pg_temp.msg('async_calls', 910005)::text);
  end loop;
  delete from system_settings where key = 'handout_sync_engine';
  insert into system_settings (key, value) values ('handout_sync_engine', '{"engine": "rest", "shadow": false}');
end $$;

\echo '=== 5. dedupe holds with a duplicate in either queue ==='
do $$
declare
  v_engine text;
  v_queue text;
  r jsonb;
begin
  -- Every combination of the engine the switch names and the queue the earlier job sits on. The
  -- earlier job is a real (unmarked) message for the same repository and revision.
  foreach v_engine in array array['rest', 'git'] loop
    foreach v_queue in array array['async_calls', 'async_calls_low_priority', 'handout_sync'] loop
      update system_settings set value = jsonb_build_object('engine', v_engine, 'shadow', false)
       where key = 'handout_sync_engine';
      perform pg_temp.reset();
      perform pgmq.send(v_queue, pg_temp.expected(910006));
      r := pg_temp.press(array[910006]::bigint[], true);
      perform pg_temp.expect(format('5 engine %s, duplicate on %s: skipped_in_flight_count', v_engine, v_queue),
        '1', r->>'skipped_in_flight_count');
      perform pg_temp.expect(format('5 engine %s, duplicate on %s: queued_count', v_engine, v_queue),
        '0', r->>'queued_count');
      perform pg_temp.expect(format('5 engine %s, duplicate on %s: still exactly one message in total', v_engine, v_queue),
        '1', (pg_temp.n('async_calls', 910006)::int + pg_temp.n('async_calls_low_priority', 910006)::int
              + pg_temp.n('handout_sync', 910006)::int)::text);
    end loop;
  end loop;

  -- The claim is per revision: a job heading to an older sha on handout_sync does not block.
  update system_settings set value = '{"engine": "rest", "shadow": false}' where key = 'handout_sync_engine';
  perform pg_temp.reset();
  perform pgmq.send('handout_sync', jsonb_set(pg_temp.expected(910006), '{args,to_sha}', '"sha-older"'));
  r := pg_temp.press(array[910006]::bigint[], true);
  perform pg_temp.expect('5 older revision on handout_sync does not block: queued_count', '1', r->>'queued_count');

  -- A claimed (invisible) message is still a claim.
  perform pg_temp.reset();
  perform pgmq.send('handout_sync', pg_temp.expected(910006));
  perform pgmq.read('handout_sync', 120, 1);
  r := pg_temp.press(array[910006]::bigint[], true);
  perform pg_temp.expect('5 claimed message on handout_sync still blocks', '1', r->>'skipped_in_flight_count');
end $$;

-- set_vt and the shadow results table --------------------------------------------------------
\echo '=== 6. pgmq_public.set_vt: service_role only ==='
do $$
declare
  v_role text;
  v_outcome text;
  v_msg bigint;
  v_vt timestamptz;
begin
  perform pg_temp.reset();
  v_msg := (select pgmq.send('handout_sync', '{"method": "sync_repo_to_handout"}'::jsonb));

  foreach v_role in array array['anon', 'authenticated'] loop
    perform pg_temp.expect('6 ' || v_role || ': has EXECUTE on set_vt', 'false',
      has_function_privilege(v_role, 'pgmq_public.set_vt(text,bigint,integer)', 'execute')::text);
    begin
      perform set_config('role', v_role, true);
      perform pgmq_public.set_vt('handout_sync', v_msg, 3600);
      v_outcome := 'allowed';
    exception when others then
      v_outcome := sqlstate;
    end;
    perform set_config('role', 'postgres', true);
    perform pg_temp.expect('6 ' || v_role || ': calling set_vt is refused with 42501', '42501', v_outcome);
  end loop;
  perform pg_temp.expect('6 PUBLIC: has EXECUTE on set_vt', 'false',
    exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             where p.oid = 'pgmq_public.set_vt(text,bigint,integer)'::regprocedure
               and a.grantee = 0 and a.privilege_type = 'EXECUTE')::text);
  perform pg_temp.expect('6 vt untouched by the refused calls', 'true',
    ((select vt from pgmq.q_handout_sync where msg_id = v_msg) <= clock_timestamp())::text);

  perform set_config('role', 'service_role', true);
  select vt into v_vt from pgmq_public.set_vt('handout_sync', v_msg, 120);
  perform set_config('role', 'postgres', true);
  perform pg_temp.expect('6 service_role: set_vt moves vt about 120s out', 'true',
    (v_vt between clock_timestamp() + interval '110 seconds' and clock_timestamp() + interval '130 seconds')::text);
  perform pg_temp.expect('6 service_role: vt stored on the queue row', v_vt::text,
    (select vt::text from pgmq.q_handout_sync where msg_id = v_msg));

  perform set_config('role', 'service_role', true);
  perform pgmq_public.archive('handout_sync', v_msg);
  v_outcome := (select count(*)::text from pgmq_public.set_vt('handout_sync', v_msg, 120));
  perform set_config('role', 'postgres', true);
  perform pg_temp.expect('6 service_role: set_vt on a gone message returns no row', '0', v_outcome);
end $$;

\echo '=== 7. handout_sync_shadow_results: service_role only ==='
do $$
declare
  v_role text;
  v_outcome text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    begin
      perform set_config('role', v_role, true);
      perform count(*) from public.handout_sync_shadow_results;
      v_outcome := 'allowed';
    exception when others then
      v_outcome := sqlstate;
    end;
    perform set_config('role', 'postgres', true);
    perform pg_temp.expect('7 ' || v_role || ': select refused', '42501', v_outcome);
    begin
      perform set_config('role', v_role, true);
      insert into public.handout_sync_shadow_results (msg_id, repository_id, to_sha) values (1, 910001, 'x');
      v_outcome := 'allowed';
    exception when others then
      v_outcome := sqlstate;
    end;
    perform set_config('role', 'postgres', true);
    perform pg_temp.expect('7 ' || v_role || ': insert refused', '42501', v_outcome);
  end loop;
  perform pg_temp.expect('7 RLS enabled', 'true',
    (select relrowsecurity::text from pg_class where oid = 'public.handout_sync_shadow_results'::regclass));
  perform pg_temp.expect('7 no policies', '0',
    (select count(*)::text from pg_policy where polrelid = 'public.handout_sync_shadow_results'::regclass));
  perform pg_temp.expect('7 no foreign keys (diagnostic rows must not block repository deletes)', '0',
    (select count(*)::text from pg_constraint where conrelid = 'public.handout_sync_shadow_results'::regclass and contype = 'f'));

  -- pg_temp functions are not executable by service_role (no EXECUTE for PUBLIC since
  -- 20261015120000), so read into a variable and switch back before recording.
  perform set_config('role', 'service_role', true);
  insert into public.handout_sync_shadow_results
    (msg_id, repository_id, to_sha, from_sha, synced_repo_sha, predicted_tree, predicted_commit_parent, unresolved)
  values (77001, 910001, 'sha-v2', 'sha-v1', 'repo-head-1', 'tree-abc', 'repo-head-1', '["src/Main.java"]');
  v_outcome := (select predicted_tree from public.handout_sync_shadow_results where repository_id = 910001);
  perform set_config('role', 'postgres', true);
  perform pg_temp.expect('7 service_role: insert and read back', 'tree-abc', v_outcome);

  -- A redelivered shadow message: the worker's ON CONFLICT (msg_id) DO NOTHING insert is a no-op
  -- and keeps the first prediction.
  perform set_config('role', 'service_role', true);
  insert into public.handout_sync_shadow_results (msg_id, repository_id, to_sha, predicted_tree)
  values (77001, 910001, 'sha-v2', 'tree-from-redelivery')
  on conflict (msg_id) do nothing;
  v_outcome := (select count(*)::text || ':' || min(predicted_tree)
                  from public.handout_sync_shadow_results where msg_id = 77001);
  perform set_config('role', 'postgres', true);
  perform pg_temp.expect('7 redelivery with ON CONFLICT (msg_id) DO NOTHING: still one row, first prediction kept',
    '1:tree-abc', v_outcome);

  -- Without ON CONFLICT the duplicate is refused outright.
  begin
    perform set_config('role', 'service_role', true);
    insert into public.handout_sync_shadow_results (msg_id, repository_id, to_sha) values (77001, 910001, 'sha-v2');
    v_outcome := 'inserted';
  exception when others then
    v_outcome := sqlstate;
  end;
  perform set_config('role', 'postgres', true);
  perform pg_temp.expect('7 plain duplicate msg_id insert fails with 23505', '23505', v_outcome);
  perform pg_temp.expect('7 msg_id is NOT NULL', 'true',
    (select attnotnull::text from pg_attribute
      where attrelid = 'public.handout_sync_shadow_results'::regclass and attname = 'msg_id'));
end $$;

\echo '=== 9. access check: manage_assignments, not instructors-only ==='
-- 9. Access check: carried over from 20261106140000 (admins or manage_assignments holders). A
-- student of the class must be refused, and the function must still ask the capability helper
-- rather than the old instructors-only check.
insert into auth.users (id, email, aud, role, instance_id)
values ('00000000-0000-0000-0000-0000000c4002', 'wp4-student@example.com', 'authenticated', 'authenticated',
        '00000000-0000-0000-0000-000000000000');
insert into users (user_id, email, name) values ('00000000-0000-0000-0000-0000000c4002', 'wp4-student@example.com', 'WP4 Student')
on conflict (user_id) do nothing;
insert into user_privileges (user_id, class_id, role) values ('00000000-0000-0000-0000-0000000c4002', 910001, 'student')
on conflict do nothing;
do $$
declare
  v_outcome text;
begin
  perform pg_temp.reset();
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '00000000-0000-0000-0000-0000000c4002', 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.queue_repository_syncs(array[910001]::bigint[], false);
    v_outcome := 'queued';
  exception when others then
    v_outcome := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect('9 a student is refused with the manage_assignments message',
    'manage_assignments is required to queue repository syncs for class 910001', v_outcome);
  perform pg_temp.expect('9 nothing was queued for the refused press', '0', pg_temp.n('handout_sync', 910001));
  perform pg_temp.expect('9 the access check asks the capability helper', 'true',
    (pg_get_functiondef('public.queue_repository_syncs(bigint[], boolean)'::regprocedure)
      like '%user_class_ids_with_capability(''manage_assignments'')%')::text);
end $$;

-- delete_assignment_with_all_data ------------------------------------------------------------
\echo '=== 8. assignment delete sees handout_sync ==='
do $$
declare
  v_outcome text;
  v_running bigint;
  r jsonb;
begin
  update system_settings set value = '{"engine": "git", "shadow": false}' where key = 'handout_sync_engine';
  perform pg_temp.reset();
  perform pg_temp.press(array[910001, 910002]::bigint[]);
  -- A shadow copy a worker is holding: plan-only, so it must not block the delete.
  perform pgmq.send('handout_sync', pg_temp.expected(910003) || '{"shadow": true}');
  perform pgmq.read('handout_sync', 600, 10);   -- claims all three, as a worker would
  -- Hand repo 2's back to the queue: unclaimed, so cancellable. The shadow copy deliberately stays
  -- claimed, to show that a claimed shadow copy neither blocks the delete nor escapes cancellation.
  update pgmq.q_handout_sync set vt = clock_timestamp() - interval '1 second'
   where message->'args'->>'repository_id' in ('910002');

  -- Repo 1's message is claimed and not shadow: the delete must refuse with 55006.
  begin
    perform public.delete_assignment_with_all_data(910001, 910001, true, null);
    v_outcome := 'deleted';
  exception when others then
    v_outcome := sqlstate;
  end;
  perform pg_temp.expect('8 claimed git sync: delete refuses with 55006', '55006', v_outcome);
  perform pg_temp.expect('8 refused delete left the queue alone', '3',
    (select count(*)::text from pgmq.q_handout_sync));

  -- Release repo 1's claim (its pod died; the heartbeat stopped). Now nothing is running: the
  -- claimed shadow copy does not count, and everything is cancelled.
  update pgmq.q_handout_sync set vt = clock_timestamp() - interval '1 second'
   where message->'args'->>'repository_id' = '910001';
  begin
    r := public.delete_assignment_with_all_data(910001, 910001, true, null);
  exception when others then
    r := jsonb_build_object('success', sqlstate || ': ' || sqlerrm);
  end;
  perform pg_temp.expect('8 delete went through', 'true', r->>'success');
  perform pg_temp.expect('8 handout_syncs_cancelled counts all three, shadow included', '3',
    r->>'handout_syncs_cancelled');
  perform pg_temp.expect('8 handout_sync is empty for the deleted repositories', '0',
    (select count(*)::text from pgmq.q_handout_sync where message->'args'->>'repository_id' like '91000_'));
  perform pg_temp.expect('8 a shadow result row for a deleted repository does not block the delete', '0',
    (select count(*)::text from repositories where class_id = 910001));
  perform pg_temp.expect('8 the shadow result row outlives its repository', '1',
    (select count(*)::text from public.handout_sync_shadow_results where repository_id = 910001));
end $$;

\echo '=== 8b. assignment delete: in_progress marker on a handout_sync message counts as running ==='
do $$
declare
  v_outcome text;
  v_msg bigint;
begin
  -- A second assignment so 8 above does not have to be undone.
  insert into assignments (id, class_id, title, slug, due_date, group_config, self_review_setting_id,
                           template_repo, latest_template_sha, release_date)
  values (910002, 910001, 'WP4 B', 'wp4-b', now() + interval '7 days', 'individual', 910001,
          'wp4-org/handout-b', 'sha-b2', now() - interval '1 day');
  insert into repositories (id, assignment_id, class_id, repository, is_github_ready, synced_handout_sha)
  values (910101, 910002, 910001, 'wp4-org/b-stu-1', true, 'sha-b1');
  perform pg_temp.reset();
  perform pg_temp.press(array[910101]::bigint[]);
  v_msg := (select msg_id from pgmq.q_handout_sync where message->'args'->>'repository_id' = '910101');
  -- The handler outlived its VT (heartbeat failed) but planted its marker.
  update pgmq.q_handout_sync set read_ct = 1, vt = clock_timestamp() - interval '1 second' where msg_id = v_msg;
  update repositories set sync_data = jsonb_build_object('status', 'in_progress', 'msg_id', v_msg) where id = 910101;
  begin
    perform public.delete_assignment_with_all_data(910002, 910001, true, null);
    v_outcome := 'deleted';
  exception when others then
    v_outcome := sqlstate;
  end;
  perform pg_temp.expect('8b marker on a handout_sync message: delete refuses with 55006', '55006', v_outcome);
end $$;

-- A fresh assignment with p_n repositories (ids p_id*10+1 ..), so each delete case below starts
-- from its own fixture and earlier deletes do not have to be undone.
create or replace function pg_temp.new_assignment(p_id bigint, p_n int) returns void language plpgsql as $$
begin
  insert into assignments (id, class_id, title, slug, due_date, group_config, self_review_setting_id,
                           template_repo, latest_template_sha, release_date)
  values (p_id, 910001, 'WP4 ' || p_id, 'wp4-' || p_id, now() + interval '7 days', 'individual', 910001,
          'wp4-org/handout-' || p_id, 'sha-' || p_id, now() - interval '1 day');
  insert into repositories (id, assignment_id, class_id, repository, is_github_ready, synced_handout_sha)
  select p_id * 10 + g, p_id, 910001, 'wp4-org/a' || p_id || '-stu-' || g, true, 'sha-old'
  from generate_series(1, p_n) g;
end $$;

-- A sync message for repository p_repo on p_queue; p_claimed makes it look held by a worker.
create or replace function pg_temp.send_sync(p_queue text, p_repo bigint, p_claimed boolean) returns bigint
language plpgsql as $$
declare
  v_msg bigint;
begin
  v_msg := (select pgmq.send(p_queue, jsonb_build_object(
    'method', 'sync_repo_to_handout', 'class_id', 910001, 'repo_id', p_repo,
    'args', jsonb_build_object('repository_id', p_repo, 'to_sha', 'sha-new',
                               'repository_full_name', (select repository from repositories where id = p_repo)))));
  if p_claimed then
    execute format('update pgmq.%I set read_ct = 1, vt = clock_timestamp() + interval ''10 minutes'' where msg_id = $1',
                   'q_' || p_queue) using v_msg;
  end if;
  return v_msg;
end $$;

-- 1 if message p_msg is still on p_queue, else 0.
create or replace function pg_temp.present(p_queue text, p_msg bigint) returns text language plpgsql as $$
declare
  v bigint;
begin
  execute format('select count(*) from pgmq.%I where msg_id = $1', 'q_' || p_queue) into v using p_msg;
  return v::text;
end $$;

\echo '=== 8c. assignment delete: the edge queues still refuse on claimed syncs and cancel unclaimed ones ==='
do $$
declare
  v_queue text;
  v_assignment bigint := 910010;
  v_claimed bigint;
  v_unclaimed bigint;
  v_outcome text;
  r jsonb;
begin
  -- The arms copied unchanged from 20261016120000, checked so the copy cannot have broken them.
  perform pg_temp.reset();
  foreach v_queue in array array['async_calls', 'async_calls_low_priority'] loop
    v_assignment := v_assignment + 1;
    perform pg_temp.new_assignment(v_assignment, 2);
    v_claimed := pg_temp.send_sync(v_queue, v_assignment * 10 + 1, true);
    v_unclaimed := pg_temp.send_sync(v_queue, v_assignment * 10 + 2, false);

    begin
      perform public.delete_assignment_with_all_data(v_assignment, 910001, true, null);
      v_outcome := 'deleted';
    exception when others then
      v_outcome := sqlstate;
    end;
    perform pg_temp.expect(format('8c %s: claimed sync refuses with 55006', v_queue), '55006', v_outcome);
    perform pg_temp.expect(format('8c %s: refused delete cancelled nothing', v_queue), '1',
      pg_temp.present(v_queue, v_unclaimed));

    -- The claim ends (handler finished elsewhere and archived it): only the unclaimed one is left.
    perform pgmq.archive(v_queue, v_claimed);
    begin
      r := public.delete_assignment_with_all_data(v_assignment, 910001, true, null);
    exception when others then
      r := jsonb_build_object('success', sqlstate || ': ' || sqlerrm);
    end;
    perform pg_temp.expect(format('8c %s: delete goes through once nothing is claimed', v_queue), 'true', r->>'success');
    perform pg_temp.expect(format('8c %s: unclaimed sync cancelled', v_queue), '0', pg_temp.present(v_queue, v_unclaimed));
    perform pg_temp.expect(format('8c %s: handout_syncs_cancelled', v_queue), '1', r->>'handout_syncs_cancelled');
  end loop;
end $$;

\echo '=== 8d. assignment delete with p_enqueue_github_archives = false against handout_sync ==='
do $$
declare
  v_claimed bigint;
  v_unclaimed bigint;
  r jsonb;
begin
  -- The legacy caller has already committed its own archive jobs, so the delete must not refuse
  -- (20261016120000, ROLLOUT). It cancels what is not running and leaves the running job alone.
  perform pg_temp.reset();
  perform pg_temp.new_assignment(910020, 2);
  v_claimed := pg_temp.send_sync('handout_sync', 9100201, true);
  v_unclaimed := pg_temp.send_sync('handout_sync', 9100202, false);
  begin
    r := public.delete_assignment_with_all_data(910020, 910001, false, null);
  exception when others then
    r := jsonb_build_object('success', sqlstate || ': ' || sqlerrm);
  end;
  perform pg_temp.expect('8d legacy caller: delete goes through despite a running git sync', 'true', r->>'success');
  perform pg_temp.expect('8d legacy caller: no archive jobs queued', '0', r->>'github_archives_queued');
  perform pg_temp.expect('8d legacy caller: handout_syncs_cancelled counts the unclaimed one only', '1',
    r->>'handout_syncs_cancelled');
  perform pg_temp.expect('8d legacy caller: unclaimed git sync cancelled', '0', pg_temp.present('handout_sync', v_unclaimed));
  perform pg_temp.expect('8d legacy caller: running git sync left in the queue', '1', pg_temp.present('handout_sync', v_claimed));
end $$;

-- Report -------------------------------------------------------------------------------------
\echo ''
\echo '=== results ==='
select seq, case when ok then 'PASS' else 'FAIL' end as result, name,
       case when ok then null else format('expected %s, got %s', expected, actual) end as detail
  from t_result order by seq;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from t_result;
select count(*) filter (where not ok) > 0 as wp4_any_failed from t_result \gset
rollback;
-- A failure has to reach the exit status. psql has no exit command, but ON_ERROR_STOP turns an
-- error into exit status 3.
\if :wp4_any_failed
  \echo 'handout_sync_routing: at least one check FAILED'
  select 1 / 0 as failed_checks;
\endif
