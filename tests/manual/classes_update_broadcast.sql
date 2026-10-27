-- Proof harness for trigger_broadcast_classes_update (migration 20261026210000).
--
-- Manual check, not run in CI. Run from the repo root against local Supabase. Everything
-- happens in one transaction that ends in ROLLBACK, so it leaves no fixtures behind:
--
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f tests/manual/classes_update_broadcast.sql
--
-- Self-contained: creates its own class and subscriber lease, so it needs no seed data.
-- It proves: one update with a live lease sends one private classes_update broadcast with the
-- expected payload, and an update without a lease sends nothing.

BEGIN;

DO $$
DECLARE
  cid bigint;
  chan_topic text;
  before_count bigint;
  after_count bigint;
  msg record;
BEGIN
  INSERT INTO public.classes (name, slug)
  VALUES ('classes_update check', 'classes-update-check-' || gen_random_uuid())
  RETURNING id INTO cid;
  chan_topic := 'class:' || cid || ':students';

  -- With a live subscriber lease, one update sends one classes_update broadcast.
  INSERT INTO public.realtime_channel_subscriptions (channel, client_id, user_id, lease_expires_at)
  VALUES (chan_topic, gen_random_uuid(), gen_random_uuid(), now() + interval '10 minutes');

  SELECT count(*) INTO before_count FROM realtime.messages WHERE realtime.messages.topic = chan_topic;
  UPDATE public.classes SET term = term WHERE id = cid;
  SELECT count(*) INTO after_count FROM realtime.messages WHERE realtime.messages.topic = chan_topic;

  IF after_count - before_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 broadcast with a subscriber, got %', after_count - before_count;
  END IF;

  -- Lease registration also sends a channel_created message on this topic; pick the update's message.
  SELECT * INTO msg FROM realtime.messages
  WHERE realtime.messages.topic = chan_topic AND payload->>'type' = 'classes_update'
  ORDER BY id DESC LIMIT 1;

  IF msg.payload->>'type' IS DISTINCT FROM 'classes_update'
     OR (msg.payload->>'class_id')::bigint IS DISTINCT FROM cid
     OR msg.payload->'data'->>'id' IS DISTINCT FROM cid::text THEN
    RAISE EXCEPTION 'unexpected payload: %', msg.payload;
  END IF;

  IF msg.private IS NOT TRUE OR msg.event IS DISTINCT FROM 'broadcast' THEN
    RAISE EXCEPTION 'expected a private broadcast event, got private=% event=%', msg.private, msg.event;
  END IF;

  -- Without a live lease, the update sends nothing (safe_broadcast checks subscribers first).
  DELETE FROM public.realtime_channel_subscriptions WHERE channel = chan_topic;

  SELECT count(*) INTO before_count FROM realtime.messages WHERE realtime.messages.topic = chan_topic;
  UPDATE public.classes SET term = term WHERE id = cid;
  SELECT count(*) INTO after_count FROM realtime.messages WHERE realtime.messages.topic = chan_topic;

  IF after_count <> before_count THEN
    RAISE EXCEPTION 'expected no broadcast without a subscriber, got %', after_count - before_count;
  END IF;

  RAISE NOTICE 'classes_update trigger checks passed';
END $$;

ROLLBACK;
