-- Proof harness for sections 9 and 13 of 20261124150500_discussion_by_capability.sql: a private
-- (instructors_only) discussion post is never queued for Discord, a thread made private has its
-- Discord message deleted, an edit to a posted
-- thread updates its message in the channel it is in, and a thread made public is posted.
--
-- Run from the repo root against local Supabase. Everything happens in one transaction that ends
-- in ROLLBACK, so it leaves nothing behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/manual/discussion_discord_private_posts.sql
--
-- Each check raises if it fails, so the script stops with an error; it ends with "ALL PASS".
-- For each of the three paths (new post, draft published, answer marked or unmarked) a public post
-- is the control (one message queued) and a private post must queue none. Then a posted thread is
-- edited (an update is queued), a never-posted one is edited (nothing is queued), and the posted one
-- is made private (a delete is queued; its tracking row stays until the worker deletes the message,
-- and the hourly sweep queues the delete again while it does). Then a posted thread moves to
-- another topic and is edited (the update names the old channel), and private threads are made
-- public (each is posted).

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
  v_args jsonb;
  v_vt timestamptz;
  v_topic2 bigint;
  v_moved bigint;
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

  -- 4. Edits. The public post is on Discord (its tracking row, as the worker writes it); the published
  -- draft isn't (the worker never ran here).
  INSERT INTO public.discord_messages (class_id, discord_message_id, discord_channel_id, resource_type, resource_id)
  VALUES (v_class, 'test-message', 'test-channel', 'discussion_thread', v_public);
  UPDATE public.discussion_threads SET body = 'Edited public body' WHERE id = v_public;
  UPDATE public.discussion_threads SET subject = 'Edited draft subject' WHERE id = v_public_draft;

  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public
    AND message ->> 'method' = 'update_message';
  -- The answer marked and unmarked earlier went out as send_message (no tracking row then), so this
  -- edit is the only update_message.
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL edit: posted thread queued % updates, expected 1', n; END IF;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public_draft
    AND message ->> 'method' <> 'send_message';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL edit: a never-posted thread queued % messages, expected 0', n; END IF;
  RAISE NOTICE 'PASS edits update a posted thread only';

  -- 5. The posted thread is made private: a delete of its message is queued.
  UPDATE public.discussion_threads SET instructors_only = true WHERE id = v_public;
  SELECT count(*), (array_agg(message -> 'args'))[1], min(vt) INTO n, v_args, v_vt FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public
    AND message ->> 'method' = 'delete_message';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL private: queued % deletes, expected 1', n; END IF;
  -- At once: only the one-time cleanup of older messages waits for the rollout.
  IF v_vt > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'FAIL private: the delete is visible at %, expected now', v_vt;
  END IF;
  IF v_args ->> 'message_id' <> 'test-message' OR v_args ->> 'channel_id' <> 'test-channel' THEN
    RAISE EXCEPTION 'FAIL private: the delete names %, expected test-message in test-channel', v_args;
  END IF;
  -- The tracking row stays until the worker has deleted the message, so a delete that is lost (an
  -- older worker dead-lettering it during a rollout) is queued again by the hourly sweep.
  SELECT count(*) INTO n FROM public.discord_messages
  WHERE resource_type::text = 'discussion_thread' AND resource_id = v_public;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL private: % tracking rows, expected the row to stay', n; END IF;
  IF public.queue_discussion_discord_deletes() < 1 THEN
    RAISE EXCEPTION 'FAIL private: the sweep queued no delete for a private thread still on Discord';
  END IF;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public
    AND message ->> 'method' = 'delete_message';
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL private: % deletes after the sweep, expected 2', n; END IF;
  -- And an edit while private queues nothing more.
  UPDATE public.discussion_threads SET body = 'Edited private body' WHERE id = v_public;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public
    AND message ->> 'method' = 'update_message';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL private: an edit while private queued an update (% in all)', n; END IF;
  RAISE NOTICE 'PASS a thread made private has its message deleted at once, and again by the sweep';

  -- 6. A posted thread moves to another linked topic, then is edited: its message is still in the
  -- old topic's channel, so the update must name that one.
  INSERT INTO public.discussion_topics (class_id, topic, color, description, ordinal, discord_channel_id)
  VALUES (v_class, 'Discord check 2', 'green', 'Discord check 2', 100, 'other-channel')
  RETURNING id INTO v_topic2;
  INSERT INTO public.discussion_threads (class_id, topic_id, author, subject, body, is_question, instructors_only, draft)
  VALUES (v_class, v_topic, v_author, 'Moved post', 'Body', true, false, false) RETURNING id INTO v_moved;
  INSERT INTO public.discord_messages (class_id, discord_message_id, discord_channel_id, resource_type, resource_id)
  VALUES (v_class, 'moved-message', 'test-channel', 'discussion_thread', v_moved);
  UPDATE public.discussion_threads SET topic_id = v_topic2 WHERE id = v_moved;
  UPDATE public.discussion_threads SET body = 'Edited after the move' WHERE id = v_moved;
  SELECT count(*), (array_agg(message -> 'args'))[1] INTO n, v_args FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_moved
    AND message ->> 'method' = 'update_message';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL moved: queued % updates, expected 1', n; END IF;
  IF v_args ->> 'channel_id' <> 'test-channel' OR v_args ->> 'message_id' <> 'moved-message' THEN
    RAISE EXCEPTION 'FAIL moved: the update names %, expected moved-message in test-channel', v_args;
  END IF;
  RAISE NOTICE 'PASS an edit after a topic move updates the message in its own channel';

  -- 7. Made public: the thread hidden in step 5 (once the worker has deleted its message and row,
  -- as done here) and the one that started private are each posted.
  DELETE FROM public.discord_messages WHERE resource_type::text = 'discussion_thread' AND resource_id = v_public;
  UPDATE public.discussion_threads SET instructors_only = false WHERE id IN (v_public, v_private);
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_private
    AND message ->> 'method' = 'send_message';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL public: a thread that started private queued % sends, expected 1', n; END IF;
  SELECT count(*) INTO n FROM pgmq.q_discord_async_calls
  WHERE message ->> 'resource_type' = 'discussion_thread' AND (message ->> 'resource_id')::bigint = v_public
    AND message ->> 'method' = 'send_message'
    AND message -> 'args' ->> 'content' LIKE '**New %';
  -- Its first post was one "New" send; being made public again queues a second.
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL public: a thread made public again queued % new-post sends, expected 2', n; END IF;
  RAISE NOTICE 'PASS a thread made public is posted';

  RAISE NOTICE 'ALL PASS';
END $$;

ROLLBACK;
