-- Proof harness for section 12 of 20261124150500_discussion_by_capability.sql: a private discussion
-- row goes to the thread's realtime channel as its id only, staff still get it in full, and a
-- question made private sends its id to the students' channel so their lists drop it.
--
-- Run from the repo root against local Supabase. Everything happens in one transaction that ends in
-- ROLLBACK, so it leaves nothing behind:
--
--   docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < tests/manual/discussion_private_realtime.sql
--
-- safe_broadcast() only sends to channels with subscribers, and nothing subscribes here, so the
-- transaction first makes channel_has_subscribers() say yes (rolled back with the rest). realtime.send()
-- then writes each message to realtime.messages, where this reads them back. Ends with "ALL PASS".

BEGIN;

CREATE OR REPLACE FUNCTION public.channel_has_subscribers(p_channel text)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

DO $$
DECLARE
  v_class bigint;
  v_author uuid;
  v_topic bigint;
  v_root bigint;
  v_public_reply bigint;
  v_private_reply bigint;
  v_data jsonb;
BEGIN
  SELECT ur.class_id, ur.private_profile_id INTO v_class, v_author
  FROM public.user_roles ur WHERE ur.role = 'student' AND ur.disabled = false LIMIT 1;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'No student enrollment to test with: seed the database first';
  END IF;
  SELECT t.id INTO v_topic FROM public.discussion_topics t WHERE t.class_id = v_class LIMIT 1;

  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
  VALUES (v_class, v_topic, v_author, 'Realtime check', 'Public question', true, false, false)
  RETURNING id INTO v_root;
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, parent, root, instructors_only)
  VALUES (v_class, v_topic, v_author, 'Re', 'Public reply text', v_root, v_root, false)
  RETURNING id INTO v_public_reply;
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, parent, root, instructors_only)
  VALUES (v_class, v_topic, v_author, 'Re', 'Private reply text', v_root, v_root, true)
  RETURNING id INTO v_private_reply;

  -- The thread channel: the public reply in full, the private one as its id only.
  SELECT m.payload -> 'data' INTO v_data FROM realtime.messages m
  WHERE m.topic = 'discussion_thread:' || v_root AND (m.payload ->> 'row_id')::bigint = v_public_reply
  ORDER BY m.inserted_at DESC LIMIT 1;
  IF v_data ->> 'body' IS DISTINCT FROM 'Public reply text' THEN
    RAISE EXCEPTION 'FAIL thread channel: the public reply was sent as %', v_data;
  END IF;
  SELECT m.payload -> 'data' INTO v_data FROM realtime.messages m
  WHERE m.topic = 'discussion_thread:' || v_root AND (m.payload ->> 'row_id')::bigint = v_private_reply
  ORDER BY m.inserted_at DESC LIMIT 1;
  IF v_data IS DISTINCT FROM jsonb_build_object('id', v_private_reply) THEN
    RAISE EXCEPTION 'FAIL thread channel: the private reply was sent as %, expected its id only', v_data;
  END IF;
  RAISE NOTICE 'PASS a private reply goes to the thread channel as its id only';

  -- The staff channel still gets the private reply in full.
  SELECT m.payload -> 'data' INTO v_data FROM realtime.messages m
  WHERE m.topic = 'class:' || v_class || ':staff' AND (m.payload ->> 'row_id')::bigint = v_private_reply
  ORDER BY m.inserted_at DESC LIMIT 1;
  IF v_data ->> 'body' IS DISTINCT FROM 'Private reply text' THEN
    RAISE EXCEPTION 'FAIL staff channel: the private reply was sent as %', v_data;
  END IF;
  RAISE NOTICE 'PASS staff still get it in full';

  -- The question is made private: the students' channel gets its id only, and an edit to the
  -- private question goes to the thread channel as its id only.
  -- (Every message in this transaction has the same inserted_at, so this looks for the id-only one.)
  UPDATE public.discussion_threads SET instructors_only = true WHERE id = v_root;
  IF NOT EXISTS (
    SELECT 1 FROM realtime.messages m
    WHERE m.topic = 'class:' || v_class || ':students' AND (m.payload ->> 'row_id')::bigint = v_root
      AND m.payload ->> 'operation' = 'UPDATE'
      AND m.payload -> 'data' = jsonb_build_object('id', v_root)
  ) THEN
    RAISE EXCEPTION 'FAIL students channel: no id-only message for the question made private';
  END IF;
  IF EXISTS (
    SELECT 1 FROM realtime.messages m
    WHERE m.topic = 'class:' || v_class || ':students' AND (m.payload ->> 'row_id')::bigint = v_root
      AND (m.payload -> 'data' ->> 'instructors_only')::boolean
  ) THEN
    RAISE EXCEPTION 'FAIL students channel: the private question was sent in full';
  END IF;
  UPDATE public.discussion_threads SET body = 'Private question text' WHERE id = v_root;
  IF EXISTS (
    SELECT 1 FROM realtime.messages m
    WHERE m.topic IN ('discussion_thread:' || v_root, 'class:' || v_class || ':students')
      AND m.payload::text LIKE '%Private question text%'
  ) THEN
    RAISE EXCEPTION 'FAIL: the private question''s text reached a thread or students channel';
  END IF;
  RAISE NOTICE 'PASS a question made private sends only its id to students';

  RAISE NOTICE 'ALL PASS';
END $$;

ROLLBACK;
