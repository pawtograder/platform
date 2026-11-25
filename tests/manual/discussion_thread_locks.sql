-- Proof harness for the locks in 20261124150500_discussion_by_capability.sql (sections 4 and 5): a
-- reply posted while its thread is being made private, or merged, waits for that change and then
-- follows it. This is the order the old code got wrong: the reply read the thread before the change
-- committed, so it stayed public, or landed in the merged duplicate's old thread.
--
-- Needs a second session, so it uses dblink (available in local Supabase; created in this
-- transaction and rolled back). The threads are created and cleaned up through that second session,
-- because they must be committed for both sessions to see them. Run from the repo root:
--
--   docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -v dblink_host="$(docker exec supabase_db_pawtograder-platform hostname -i)" < tests/manual/discussion_thread_locks.sql
--
-- dblink_host is the database container's own network address: dblink must sign in with the password,
-- which local Supabase only asks for on that address, not on 127.0.0.1.
--
-- Each check raises if it fails; it ends with "ALL PASS".

BEGIN;
CREATE EXTENSION IF NOT EXISTS dblink;
SELECT set_config('harness.dblink_host', :'dblink_host', true);

DO $$
DECLARE
  v_conn text := 'dbname=postgres user=postgres password=postgres port=5432 host='
    || current_setting('harness.dblink_host');
  v_class bigint;
  v_topic bigint;
  v_student uuid;
  v_student_profile uuid;
  v_grader uuid;
  v_root bigint;
  v_orig bigint;
  v_dup bigint;
  v_reply text;
  v_err text;
  v_private boolean;
  v_hidden boolean;
  n int;
BEGIN
  SELECT s.class_id, s.user_id, s.private_profile_id, g.user_id
  INTO v_class, v_student, v_student_profile, v_grader
  FROM public.user_roles s
  JOIN public.user_roles g ON g.class_id = s.class_id AND g.role IN ('grader', 'instructor') AND g.disabled = false
  WHERE s.role = 'student' AND s.disabled = false
    AND s.class_id IN (SELECT rc_cr.class_id FROM public.class_roles rc_cr
                       JOIN public.role_capabilities rc ON rc.role_id = rc_cr.id
                       WHERE rc_cr.id = g.class_role_id AND rc.capability = 'moderate_discussion')
  ORDER BY g.role  -- a grader if there is one
  LIMIT 1;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'No class with a student and a staff member who holds moderate_discussion: seed the database first';
  END IF;
  SELECT t.id INTO v_topic FROM public.discussion_topics t WHERE t.class_id = v_class LIMIT 1;

  -- Committed setup through a second session.
  PERFORM dblink_connect('setup', v_conn);
  SELECT id INTO v_root FROM dblink('setup', format(
    $q$INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
       VALUES (%s, %s, %L, 'Lock check', 'Body', true, false, false) RETURNING id$q$,
    v_class, v_topic, v_student_profile)) AS t(id bigint);
  SELECT id INTO v_orig FROM dblink('setup', format(
    $q$INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
       VALUES (%s, %s, %L, 'Lock check original', 'Body', true, false, false) RETURNING id$q$,
    v_class, v_topic, v_student_profile)) AS t(id bigint);
  SELECT id INTO v_dup FROM dblink('setup', format(
    $q$INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
       VALUES (%s, %s, %L, 'Lock check duplicate', 'Body', true, false, false) RETURNING id$q$,
    v_class, v_topic, v_student_profile)) AS t(id bigint);

  PERFORM dblink_connect('moderator', v_conn);
  PERFORM dblink_connect('replier', v_conn);

  -- 1. A moderator makes the thread private and hasn't committed yet; the student posts a reply.
  PERFORM dblink_exec('moderator', 'BEGIN');
  PERFORM dblink_exec('moderator', format('SET LOCAL request.jwt.claims = %L',
    json_build_object('sub', v_grader, 'role', 'authenticated')::text));
  PERFORM * FROM dblink('moderator', format('SELECT public.set_discussion_thread_visibility(%s, true)::text', v_root))
    AS t(r text);

  PERFORM dblink_exec('replier', 'BEGIN');
  PERFORM dblink_exec('replier', format('SET LOCAL request.jwt.claims = %L',
    json_build_object('sub', v_student, 'role', 'authenticated')::text));
  PERFORM dblink_exec('replier', 'SET LOCAL ROLE authenticated');
  PERFORM dblink_send_query('replier', format(
    $q$INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, parent, root, instructors_only)
       VALUES (%s, %s, %L, 'Re', 'Reply in flight', %s, %s, false) RETURNING id::text$q$,
    v_class, v_topic, v_student_profile, v_root, v_root));
  PERFORM pg_sleep(0.5);
  IF dblink_is_busy('replier') <> 1 THEN
    RAISE EXCEPTION 'FAIL visibility: the reply did not wait for the visibility change';
  END IF;

  PERFORM dblink_exec('moderator', 'COMMIT');
  SELECT r INTO v_reply FROM dblink_get_result('replier') AS t(r text);
  PERFORM * FROM dblink_get_result('replier') AS t(r text);
  PERFORM dblink_exec('replier', 'COMMIT');
  SELECT instructors_only, hidden_with_thread INTO v_private, v_hidden
  FROM public.discussion_threads WHERE id = v_reply::bigint;
  IF NOT v_private OR NOT v_hidden THEN
    RAISE EXCEPTION 'FAIL visibility: the reply posted during the change is instructors_only=%, hidden_with_thread=%',
      v_private, v_hidden;
  END IF;
  RAISE NOTICE 'PASS a reply posted while its thread is made private waits, then is private with it';

  -- 2. A moderator merges the duplicate and hasn't committed yet; the student replies to the duplicate.
  PERFORM dblink_exec('moderator', 'BEGIN');
  PERFORM dblink_exec('moderator', format('SET LOCAL request.jwt.claims = %L',
    json_build_object('sub', v_grader, 'role', 'authenticated')::text));
  PERFORM * FROM dblink('moderator', format('SELECT public.mark_discussion_thread_duplicate(%s, %s)::text', v_dup, v_orig))
    AS t(r text);

  PERFORM dblink_exec('replier', 'BEGIN');
  PERFORM dblink_exec('replier', format('SET LOCAL request.jwt.claims = %L',
    json_build_object('sub', v_student, 'role', 'authenticated')::text));
  PERFORM dblink_exec('replier', 'SET LOCAL ROLE authenticated');
  PERFORM dblink_send_query('replier', format(
    $q$INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, parent, root)
       VALUES (%s, %s, %L, 'Re', 'Reply to the duplicate', %s, %s) RETURNING id::text$q$,
    v_class, v_topic, v_student_profile, v_dup, v_dup));
  PERFORM pg_sleep(0.5);
  IF dblink_is_busy('replier') <> 1 THEN
    RAISE EXCEPTION 'FAIL merge: the reply did not wait for the merge';
  END IF;

  PERFORM dblink_exec('moderator', 'COMMIT');
  PERFORM * FROM dblink_get_result('replier', false) AS t(r text);
  v_err := dblink_error_message('replier');
  PERFORM * FROM dblink_get_result('replier', false) AS t(r text);
  PERFORM dblink_exec('replier', 'ROLLBACK');
  IF v_err IS NULL OR v_err = 'OK' OR v_err NOT LIKE '%same thread%' THEN
    RAISE EXCEPTION 'FAIL merge: a reply to the duplicate posted during the merge got "%", expected a refusal', v_err;
  END IF;
  SELECT count(*) INTO n FROM public.discussion_threads WHERE body = 'Reply to the duplicate' AND root IN (v_dup, v_orig);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL merge: % replies to the duplicate were stored', n;
  END IF;
  RAISE NOTICE 'PASS a reply to a duplicate being merged waits, then is refused instead of landing in the old thread';

  -- Clean up the committed rows: read status and watches, then replies, then the questions.
  PERFORM dblink_exec('setup', format(
    'DELETE FROM public.discussion_thread_read_status WHERE discussion_thread_root_id IN (%1$s, %2$s, %3$s)
       OR discussion_thread_id IN (SELECT id FROM public.discussion_threads WHERE root IN (%1$s, %2$s, %3$s))',
    v_root, v_orig, v_dup));
  PERFORM dblink_exec('setup', format(
    'DELETE FROM public.discussion_thread_watchers WHERE discussion_thread_root_id IN (%s, %s, %s)',
    v_root, v_orig, v_dup));
  PERFORM dblink_exec('setup', format(
    'DELETE FROM public.discussion_threads WHERE root IN (%1$s, %2$s, %3$s) AND id NOT IN (%1$s, %2$s, %3$s)',
    v_root, v_orig, v_dup));
  PERFORM dblink_exec('setup', format('DELETE FROM public.discussion_threads WHERE id IN (%s, %s)', v_dup, v_root));
  PERFORM dblink_exec('setup', format('DELETE FROM public.discussion_threads WHERE id = %s', v_orig));
  PERFORM dblink_disconnect('moderator');
  PERFORM dblink_disconnect('replier');
  PERFORM dblink_disconnect('setup');

  RAISE NOTICE 'ALL PASS';
END $$;

ROLLBACK;
