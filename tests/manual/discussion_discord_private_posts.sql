-- Proof harness for section 9 of 20261123180300_discussion_by_capability.sql: a private
-- (instructors_only) discussion post is never queued for Discord.
--
-- Run from the repo root against local Supabase. Everything happens in one transaction that ends
-- in ROLLBACK, so it leaves nothing behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/manual/discussion_discord_private_posts.sql
--
-- Each check raises if it fails, so the script stops with an error; it ends with "ALL PASS".
-- For each of the three paths (new post, draft published, answer marked or unmarked) a public post
-- is the control (one message queued) and a private post must queue none.

BEGIN;

DO $$
DECLARE
  v_class bigint;
  v_author uuid;
  v_topic bigint;
  v_public bigint;
  v_private bigint;
  v_public_draft bigint;
  v_private_draft bigint;
  v_reply bigint;
  v_private_reply bigint;
  n int;
BEGIN
  SELECT ur.class_id, ur.private_profile_id INTO v_class, v_author
  FROM public.user_roles ur WHERE ur.role = 'student' AND ur.disabled = false LIMIT 1;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'No student enrollment to test with: seed the database first';
  END IF;

  UPDATE public.classes SET discord_server_id = 'test-server' WHERE id = v_class;
  INSERT INTO public.discussion_topics (class_id, topic, color, description, ordinal, discord_channel_id)
  VALUES (v_class, 'Discord check', 'blue', 'Discord check', 99, 'test-channel')
  RETURNING id INTO v_topic;

  -- 1. A new post.
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
  VALUES (v_class, v_topic, v_author, 'Public post', 'Public body', true, false, false) RETURNING id INTO v_public;
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
  VALUES (v_class, v_topic, v_author, 'Private post', 'Private body', true, true, false) RETURNING id INTO v_private;

  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL new post: public post queued % messages, expected 1', n; END IF;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_private;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL new post: private post queued % messages, expected 0', n; END IF;
  RAISE NOTICE 'PASS new post';

  -- 2. A draft that is published.
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
  VALUES (v_class, v_topic, v_author, 'Public draft', 'Body', true, false, true) RETURNING id INTO v_public_draft;
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
  VALUES (v_class, v_topic, v_author, 'Private draft', 'Body', true, true, true) RETURNING id INTO v_private_draft;
  UPDATE public.discussion_threads SET draft = false WHERE id IN (v_public_draft, v_private_draft);

  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public_draft;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL publish: public draft queued % messages, expected 1', n; END IF;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_private_draft;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL publish: private draft queued % messages, expected 0', n; END IF;
  RAISE NOTICE 'PASS draft published';

  -- 3. An answer marked, then unmarked.
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, parent, root, instructors_only)
  VALUES (v_class, v_topic, v_author, 'Re', 'Reply', v_public, v_public, false) RETURNING id INTO v_reply;
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, parent, root, instructors_only)
  VALUES (v_class, v_topic, v_author, 'Re', 'Reply', v_private, v_private, true) RETURNING id INTO v_private_reply;
  UPDATE public.discussion_threads SET answer = v_reply WHERE id = v_public;
  UPDATE public.discussion_threads SET answer = v_private_reply WHERE id = v_private;
  UPDATE public.discussion_threads SET answer = NULL WHERE id IN (v_public, v_private);

  -- The public post: created, answered, unmarked = 3 messages.
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public;
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL answer: public post queued % messages, expected 3', n; END IF;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_private;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL answer: private post queued % messages, expected 0', n; END IF;
  RAISE NOTICE 'PASS answer marked and unmarked';

  RAISE NOTICE 'ALL PASS';
END $$;

ROLLBACK;
