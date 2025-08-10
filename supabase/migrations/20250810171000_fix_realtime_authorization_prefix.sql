-- Fix: normalize 'realtime:' prefix in realtime topic authorization and add NOTICE logs for debugging
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.check_unified_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  raw_topic text := topic_text;
  t text := regexp_replace(topic_text, '^realtime:', ''); -- strip leading 'realtime:' if present
  parts text[] := string_to_array(t, ':');
  topic_type text;
  class_id_bigint bigint;
  submission_id_bigint bigint;
  profile_id_uuid uuid;
  help_request_id_bigint bigint;
  help_queue_id_bigint bigint;
  is_class_grader boolean := false;
  is_submission_authorized boolean := false;
  is_profile_owner boolean := false;
  allowed boolean := false;
BEGIN
  topic_type := CASE WHEN array_length(parts, 1) >= 1 THEN parts[1] ELSE NULL END;

  -- Basic topics
  IF t = 'help_queues' THEN
    allowed := auth.role() = 'authenticated';
    RAISE NOTICE '[check_auth] raw=%, norm=%, type=help_queues, allowed=%', raw_topic, t, allowed;
    RETURN allowed;
  END IF;

  -- class:* channels
  IF topic_type = 'class' AND array_length(parts, 1) >= 3 THEN
    BEGIN
      class_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid class_id: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END;

    IF array_length(parts, 1) = 3 THEN
      RAISE NOTICE '[check_auth] class channel missing subtype: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END IF;

    IF parts[3] = 'staff' THEN
      allowed := public.authorizeforclassgrader(class_id_bigint);
      RAISE NOTICE '[check_auth] class:staff raw=%, norm=%, class_id=%, allowed=%', raw_topic, t, class_id_bigint, allowed;
      RETURN allowed;
    ELSIF parts[3] = 'user' AND array_length(parts, 1) = 4 THEN
      BEGIN
        profile_id_uuid := parts[4]::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '[check_auth] invalid profile uuid: raw=%, norm=%', raw_topic, t;
        RETURN false;
      END;
      is_class_grader := public.authorizeforclassgrader(class_id_bigint);
      is_profile_owner := public.authorizeforprofile(profile_id_uuid);
      allowed := is_class_grader OR is_profile_owner;
      RAISE NOTICE '[check_auth] class:user raw=%, norm=%, class_id=%, profile=%, grader=%, owner=%, allowed=%', raw_topic, t, class_id_bigint, profile_id_uuid, is_class_grader, is_profile_owner, allowed;
      RETURN allowed;
    ELSE
      RAISE NOTICE '[check_auth] unknown class subtype: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END IF;
  END IF;

  -- help_request:* channels
  IF topic_type = 'help_request' AND array_length(parts, 1) >= 2 THEN
    BEGIN
      help_request_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid help_request_id: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END;

    IF array_length(parts, 1) = 3 AND parts[3] = 'staff' THEN
      SELECT hr.class_id INTO class_id_bigint FROM public.help_requests hr WHERE hr.id = help_request_id_bigint;
      is_class_grader := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclassgrader(class_id_bigint) ELSE false END;
      allowed := is_class_grader OR public.can_access_help_request(help_request_id_bigint);
      RAISE NOTICE '[check_auth] help_request:staff raw=%, norm=%, req=%, class=%, grader=%, allowed=%', raw_topic, t, help_request_id_bigint, class_id_bigint, is_class_grader, allowed;
      RETURN allowed;
    ELSE
      allowed := public.can_access_help_request(help_request_id_bigint);
      RAISE NOTICE '[check_auth] help_request raw=%, norm=%, req=%, allowed=%', raw_topic, t, help_request_id_bigint, allowed;
      RETURN allowed;
    END IF;
  END IF;

  -- help_queue:* channels
  IF topic_type = 'help_queue' AND array_length(parts, 1) >= 2 THEN
    BEGIN
      help_queue_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid help_queue_id: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END;
    SELECT hq.class_id INTO class_id_bigint FROM public.help_queues hq WHERE hq.id = help_queue_id_bigint;
    allowed := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclass(class_id_bigint) ELSE false END;
    RAISE NOTICE '[check_auth] help_queue raw=%, norm=%, queue=%, class=%, allowed=%', raw_topic, t, help_queue_id_bigint, class_id_bigint, allowed;
    RETURN allowed;
  END IF;

  -- submission:* channels
  IF topic_type = 'submission' AND array_length(parts, 1) >= 3 THEN
    BEGIN
      submission_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid submission_id: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END;

    IF array_length(parts, 1) = 3 THEN
      RAISE NOTICE '[check_auth] submission channel missing subtype: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END IF;

    IF parts[3] = 'graders' THEN
      SELECT s.class_id INTO class_id_bigint FROM public.submissions s WHERE s.id = submission_id_bigint;
      allowed := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclassgrader(class_id_bigint) ELSE false END;
      RAISE NOTICE '[check_auth] submission:graders raw=%, norm=%, sub=%, class=%, allowed=%', raw_topic, t, submission_id_bigint, class_id_bigint, allowed;
      RETURN allowed;
    ELSIF parts[3] = 'profile_id' AND array_length(parts, 1) = 4 THEN
      BEGIN
        profile_id_uuid := parts[4]::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '[check_auth] invalid submission profile_id uuid: raw=%, norm=%', raw_topic, t;
        RETURN false;
      END;
      is_submission_authorized := public.authorize_for_submission(submission_id_bigint);
      is_profile_owner := public.authorizeforprofile(profile_id_uuid);
      SELECT s.class_id INTO class_id_bigint FROM public.submissions s WHERE s.id = submission_id_bigint;
      is_class_grader := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclassgrader(class_id_bigint) ELSE false END;
      allowed := is_class_grader OR is_submission_authorized OR is_profile_owner;
      RAISE NOTICE '[check_auth] submission:profile raw=%, norm=%, sub=%, class=%, profile=%, grader=%, subauth=%, owner=%, allowed=%', raw_topic, t, submission_id_bigint, class_id_bigint, profile_id_uuid, is_class_grader, is_submission_authorized, is_profile_owner, allowed;
      RETURN allowed;
    ELSE
      RAISE NOTICE '[check_auth] unknown submission subtype: raw=%, norm=%', raw_topic, t;
      RETURN false;
    END IF;
  END IF;

  RAISE NOTICE '[check_auth] unknown topic: raw=%, norm=%', raw_topic, t;
  RETURN false;
END;
$function$;