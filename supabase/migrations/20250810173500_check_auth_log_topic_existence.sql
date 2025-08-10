-- Enhance authorization logging: check topic existence in realtime.messages and precreation preconditions
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.check_unified_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  raw_topic text := topic_text;
  t text := regexp_replace(topic_text, '^realtime:', ''); -- normalize 'realtime:' prefix
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
  prev_rowsec text;
  topic_count int := 0;
  pre_rows int := 0;
BEGIN
  -- Attempt to detect if the topic already exists in realtime.messages (bypassing RLS)
  BEGIN
    prev_rowsec := current_setting('row_security', true);
  EXCEPTION WHEN OTHERS THEN
    prev_rowsec := NULL;
  END;
  PERFORM set_config('row_security', 'off', true);
  BEGIN
    SELECT COUNT(*) INTO topic_count FROM realtime.messages WHERE topic = raw_topic OR topic = t;
  EXCEPTION WHEN OTHERS THEN
    topic_count := -1; -- indicate failure to query
  END;
  -- Restore row_security if it existed
  IF prev_rowsec IS NOT NULL THEN
    PERFORM set_config('row_security', prev_rowsec, true);
  ELSE
    PERFORM set_config('row_security', 'on', true);
  END IF;

  topic_type := CASE WHEN array_length(parts, 1) >= 1 THEN parts[1] ELSE NULL END;

  IF t = 'help_queues' THEN
    allowed := auth.role() = 'authenticated';
    RAISE NOTICE '[check_auth] topic=help_queues raw=%, norm=%, topic_count=%, allowed=%', raw_topic, t, topic_count, allowed;
    RETURN allowed;
  END IF;

  IF topic_type = 'class' AND array_length(parts, 1) >= 3 THEN
    BEGIN
      class_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid class_id raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
      RETURN false;
    END;

    IF array_length(parts, 1) = 3 THEN
      RAISE NOTICE '[check_auth] class missing subtype raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
      RETURN false;
    END IF;

    IF parts[3] = 'staff' THEN
      SELECT COUNT(*) INTO pre_rows FROM public.classes WHERE id = class_id_bigint;
      allowed := public.authorizeforclassgrader(class_id_bigint);
      RAISE NOTICE '[check_auth] class:staff raw=%, norm=%, class_id=%, pre_rows(classes)=%, topic_count=%, allowed=%', raw_topic, t, class_id_bigint, pre_rows, topic_count, allowed;
      RETURN allowed;
    ELSIF parts[3] = 'user' AND array_length(parts, 1) = 4 THEN
      BEGIN
        profile_id_uuid := parts[4]::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '[check_auth] invalid profile uuid raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
        RETURN false;
      END;
      SELECT COUNT(*) INTO pre_rows FROM public.user_roles WHERE class_id = class_id_bigint AND private_profile_id = profile_id_uuid;
      is_class_grader := public.authorizeforclassgrader(class_id_bigint);
      is_profile_owner := public.authorizeforprofile(profile_id_uuid);
      allowed := is_class_grader OR is_profile_owner;
      RAISE NOTICE '[check_auth] class:user raw=%, norm=%, class_id=%, profile=%, pre_rows(user_roles)=%, topic_count=%, grader=%, owner=%, allowed=%', raw_topic, t, class_id_bigint, profile_id_uuid, pre_rows, topic_count, is_class_grader, is_profile_owner, allowed;
      RETURN allowed;
    ELSE
      RAISE NOTICE '[check_auth] unknown class subtype raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
      RETURN false;
    END IF;
  END IF;

  IF topic_type = 'help_request' AND array_length(parts, 1) >= 2 THEN
    BEGIN
      help_request_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid help_request raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
      RETURN false;
    END;

    SELECT COUNT(*) INTO pre_rows FROM public.help_requests WHERE id = help_request_id_bigint;
    IF array_length(parts, 1) = 3 AND parts[3] = 'staff' THEN
      SELECT hr.class_id INTO class_id_bigint FROM public.help_requests hr WHERE hr.id = help_request_id_bigint;
      is_class_grader := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclassgrader(class_id_bigint) ELSE false END;
      allowed := is_class_grader OR public.can_access_help_request(help_request_id_bigint);
      RAISE NOTICE '[check_auth] help_request:staff raw=%, norm=%, req=%, pre_rows(help_requests)=%, topic_count=%, class=%, grader=%, allowed=%', raw_topic, t, help_request_id_bigint, pre_rows, topic_count, class_id_bigint, is_class_grader, allowed;
      RETURN allowed;
    ELSE
      allowed := public.can_access_help_request(help_request_id_bigint);
      RAISE NOTICE '[check_auth] help_request raw=%, norm=%, req=%, pre_rows(help_requests)=%, topic_count=%, allowed=%', raw_topic, t, help_request_id_bigint, pre_rows, topic_count, allowed;
      RETURN allowed;
    END IF;
  END IF;

  IF topic_type = 'help_queue' AND array_length(parts, 1) >= 2 THEN
    BEGIN
      help_queue_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid help_queue raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
      RETURN false;
    END;
    SELECT COUNT(*) INTO pre_rows FROM public.help_queues WHERE id = help_queue_id_bigint;
    SELECT hq.class_id INTO class_id_bigint FROM public.help_queues hq WHERE hq.id = help_queue_id_bigint;
    allowed := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclass(class_id_bigint) ELSE false END;
    RAISE NOTICE '[check_auth] help_queue raw=%, norm=%, queue=%, pre_rows(help_queues)=%, topic_count=%, class=%, allowed=%', raw_topic, t, help_queue_id_bigint, pre_rows, topic_count, class_id_bigint, allowed;
    RETURN allowed;
  END IF;

  IF topic_type = 'submission' AND array_length(parts, 1) >= 3 THEN
    BEGIN
      submission_id_bigint := parts[2]::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[check_auth] invalid submission raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
      RETURN false;
    END;
    SELECT COUNT(*) INTO pre_rows FROM public.submissions WHERE id = submission_id_bigint;

    IF array_length(parts, 1) = 3 THEN
      RAISE NOTICE '[check_auth] submission missing subtype raw=%, norm=%, pre_rows(submissions)=%, topic_count=%', raw_topic, t, pre_rows, topic_count;
      RETURN false;
    END IF;

    IF parts[3] = 'graders' THEN
      SELECT s.class_id INTO class_id_bigint FROM public.submissions s WHERE s.id = submission_id_bigint;
      allowed := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclassgrader(class_id_bigint) ELSE false END;
      RAISE NOTICE '[check_auth] submission:graders raw=%, norm=%, sub=%, pre_rows(submissions)=%, topic_count=%, class=%, allowed=%', raw_topic, t, submission_id_bigint, pre_rows, topic_count, class_id_bigint, allowed;
      RETURN allowed;
    ELSIF parts[3] = 'profile_id' AND array_length(parts, 1) = 4 THEN
      BEGIN
        profile_id_uuid := parts[4]::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '[check_auth] invalid submission profile uuid raw=%, norm=%, pre_rows(submissions)=%, topic_count=%', raw_topic, t, pre_rows, topic_count;
        RETURN false;
      END;
      is_submission_authorized := public.authorize_for_submission(submission_id_bigint);
      is_profile_owner := public.authorizeforprofile(profile_id_uuid);
      SELECT s.class_id INTO class_id_bigint FROM public.submissions s WHERE s.id = submission_id_bigint;
      is_class_grader := CASE WHEN class_id_bigint IS NOT NULL THEN public.authorizeforclassgrader(class_id_bigint) ELSE false END;
      allowed := is_class_grader OR is_submission_authorized OR is_profile_owner;
      RAISE NOTICE '[check_auth] submission:profile raw=%, norm=%, sub=%, pre_rows(submissions)=%, topic_count=%, class=%, profile=%, grader=%, subauth=%, owner=%, allowed=%', raw_topic, t, submission_id_bigint, pre_rows, topic_count, class_id_bigint, profile_id_uuid, is_class_grader, is_submission_authorized, is_profile_owner, allowed;
      RETURN allowed;
    ELSE
      RAISE NOTICE '[check_auth] unknown submission subtype raw=%, norm=%, pre_rows(submissions)=%, topic_count=%', raw_topic, t, pre_rows, topic_count;
      RETURN false;
    END IF;
  END IF;

  RAISE NOTICE '[check_auth] unknown topic raw=%, norm=%, topic_count=%', raw_topic, t, topic_count;
  RETURN false;
END;
$function$;