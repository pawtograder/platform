-- #1010: moderating discussions follows the moderate_discussion capability.
--
-- Why: moderation (pin, edit others' posts, mark an answer, mark a duplicate, move to a topic,
-- reveal or hide a poster, change who can see a thread) was decided by the app role: every
-- instructor and grader could do it, and no role could be given less. Now one capability decides,
-- in the database and on the thread page, and an instructor can take it off a role.
--
-- What:
--   1. New capability moderate_discussion, on the default instructor role, the default grader role
--      and every custom role of every class. Graders can moderate today, so nobody loses anything.
--   2. seed_default_class_roles() gives new classes' default grader role every grader capability,
--      listed by name. Names that don't exist yet are skipped, so this list can name the grader
--      capabilities of open PRs (#1299, #1300, #1301, #1408, #1409, #1410) without failing, and
--      whichever of those merges first doesn't lose the others'. Keep the list complete when a
--      grader capability is added.
--   3. discussion_threads: the staff UPDATE (pinning, editing others' posts and replies, marking
--      answers) needs moderate_discussion in the thread's class. Authors can still update their
--      own posts, as before.
--   4. set_discussion_thread_topic, mark_discussion_thread_duplicate,
--      toggle_discussion_thread_author_anonymity and the staff part of
--      set_discussion_thread_visibility check moderate_discussion instead of the app role. The
--      author part of set_discussion_thread_visibility is unchanged. Only those checks change.
--   5. Pinning, answers, topics and classes: an author could update every column of their own post,
--      so a student could pin it, set its answer to anything, move it to another topic or move it
--      into another class through the API. Now only a moderator can pin or unpin, change a post's
--      topic, or create a pinned post; no new post can start with an answer (it has no replies yet);
--      only the question's author or a moderator can mark or unmark an answer, and the answer must be
--      a reply in that thread; and no signed-in user can move a post to another class.
--
-- Not changed: reading threads, posting, likes, follows, read status, discussion topics, error
-- pins, AI help, discussion engagement and the Discord link.
--
-- Run once. The role backfill in section 1 is for the first rollout only: running it again would
-- put moderate_discussion back on every role an instructor has taken it off.

-- ---------------------------------------------------------------------------
-- 1. The capability, on the instructor, grader and custom roles
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('moderate_discussion', 'Pin, edit, answer, merge, move and hide discussion posts')
ON CONFLICT (name) DO NOTHING;

-- Every grader can moderate today, so every role a grader can be on gets it: the default grader
-- role and every custom role (a custom role is a copy of the grader role made earlier).
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'moderate_discussion'
FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. New classes: the default grader role gets every grader capability
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.seed_default_class_roles(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.class_roles (class_id, name, default_for)
  VALUES
    (p_class_id, 'instructor', 'instructor'),
    (p_class_id, 'grader', 'grader'),
    (p_class_id, 'student', 'student'),
    (p_class_id, 'admin', 'admin')
  ON CONFLICT DO NOTHING;

  -- The instructor role holds every capability.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  CROSS JOIN public.capabilities c
  WHERE cr.class_id = p_class_id AND cr.default_for = 'instructor'
  ON CONFLICT DO NOTHING;

  -- The grader role holds what every grader could do before #1010. The JOIN skips any name that
  -- isn't a capability yet, so this list may name capabilities from PRs that haven't merged.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  JOIN public.capabilities c ON c.name = ANY (ARRAY[
      'moderate_discussion',
      'grade_submissions',
      'handle_regrades',
      'grant_extensions',
      'help_students',
      'manage_flashcards',
      'run_polls'
    ])
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. discussion_threads: staff updates need moderate_discussion; authors keep their own posts
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors and graders can update pinned status" ON public.discussion_threads;
DROP POLICY IF EXISTS "self updates, or instructor or grader" ON public.discussion_threads;
DROP POLICY IF EXISTS "Discussion moderators can update threads" ON public.discussion_threads;
DROP POLICY IF EXISTS "Authors can update their own threads" ON public.discussion_threads;

CREATE POLICY "Discussion moderators can update threads" ON public.discussion_threads
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion')));

-- The author branch of the old "self updates, or instructor or grader". The updated row must still
-- be the author's own post in the author's own class, so an author can't move it into another class.
CREATE POLICY "Authors can update their own threads" ON public.discussion_threads
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (up.public_profile_id = discussion_threads.author OR up.private_profile_id = discussion_threads.author)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = discussion_threads.class_id
        AND (up.public_profile_id = discussion_threads.author OR up.private_profile_id = discussion_threads.author)
    )
  );

-- ---------------------------------------------------------------------------
-- 4. The moderation functions: latest bodies, only the permission check changes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_discussion_thread_topic(p_thread_id bigint, p_topic_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_thread_class_id bigint;
  v_thread_root bigint;
  v_topic_class_id bigint;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  
  -- Get the thread and verify it exists
  SELECT class_id, root
  INTO v_thread_class_id, v_thread_root
  FROM public.discussion_threads
  WHERE id = p_thread_id;
  
  IF v_thread_class_id IS NULL THEN
    RAISE EXCEPTION 'Thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  
  -- Verify this is a root thread (root is NULL or equals id)
  IF v_thread_root IS NOT NULL AND v_thread_root != p_thread_id THEN
    RAISE EXCEPTION 'Can only set topic for root posts'
      USING ERRCODE = 'check_violation';
  END IF;
  
  -- Check that the caller holds moderate_discussion in this class (#1010)
  IF NOT (v_thread_class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'))) THEN
    RAISE EXCEPTION 'Access denied: moderate_discussion required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  
  -- Validate that topic belongs to the same class as the thread
  IF p_topic_id IS NOT NULL THEN
    SELECT class_id INTO v_topic_class_id
    FROM public.discussion_topics
    WHERE id = p_topic_id;
    
    IF v_topic_class_id IS NULL THEN
      RAISE EXCEPTION 'Topic not found'
        USING ERRCODE = 'no_data_found';
    END IF;
    
    IF v_topic_class_id != v_thread_class_id THEN
      RAISE EXCEPTION 'Topic does not belong to the same class as the thread'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  
  -- Update the root thread and all descendant threads atomically
  -- All updates happen in a single transaction (implicit)
  UPDATE public.discussion_threads
  SET topic_id = p_topic_id
  WHERE id = p_thread_id;
  
  -- Update all descendant threads (replies) to match the root topic
  UPDATE public.discussion_threads
  SET topic_id = p_topic_id
  WHERE root = p_thread_id
    AND id != p_thread_id;  -- Don't update the root again
  
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_discussion_thread_duplicate(p_duplicate_root_id bigint, p_original_root_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dup_class_id bigint;
  v_dup_root bigint;
  v_dup_subject text;
  v_dup_author_profile uuid;
  v_orig_class_id bigint;
  v_orig_root bigint;
  v_orig_topic_id bigint;
  v_orig_instructors_only boolean;
  v_author_user_id uuid;
  v_staff_name text;
  v_orig_subject text;
  v_dup_ordinal integer;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  -- SECURITY DEFINER still applies RLS as the invoker; disable for this body so
  -- discussion_threads SELECT policy cannot recurse (42P17) during root/parent updates.
  PERFORM set_config('row_security', 'off', true);

  IF p_duplicate_root_id = p_original_root_id THEN
    RAISE EXCEPTION 'Cannot mark a thread as a duplicate of itself'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT dt.class_id, dt.root, dt.subject, dt.author, dt.ordinal
  INTO v_dup_class_id, v_dup_root, v_dup_subject, v_dup_author_profile, v_dup_ordinal
  FROM public.discussion_threads dt
  WHERE dt.id = p_duplicate_root_id;

  IF v_dup_class_id IS NULL THEN
    RAISE EXCEPTION 'Duplicate thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_dup_root IS NULL OR v_dup_root != p_duplicate_root_id THEN
    RAISE EXCEPTION 'Can only mark root discussion posts as duplicates'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT dt.class_id, dt.root, dt.topic_id, dt.instructors_only, dt.subject
  INTO v_orig_class_id, v_orig_root, v_orig_topic_id, v_orig_instructors_only, v_orig_subject
  FROM public.discussion_threads dt
  WHERE dt.id = p_original_root_id;

  IF v_orig_class_id IS NULL THEN
    RAISE EXCEPTION 'Original thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_orig_root IS NULL OR v_orig_root != p_original_root_id THEN
    RAISE EXCEPTION 'Original must be a root discussion post'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_dup_class_id != v_orig_class_id THEN
    RAISE EXCEPTION 'Threads must belong to the same class'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.discussion_threads o
    WHERE o.id = p_original_root_id
      AND (o.id = p_duplicate_root_id OR o.root = p_duplicate_root_id)
  ) THEN
    RAISE EXCEPTION 'Original thread cannot be the duplicate or a reply under the duplicate'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The caller must hold moderate_discussion in the class (#1010)
  IF NOT (v_dup_class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'))) THEN
    RAISE EXCEPTION 'Access denied: moderate_discussion required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ur.user_id
  INTO v_author_user_id
  FROM public.user_roles ur
  WHERE ur.class_id = v_dup_class_id
    AND ur.disabled = false
    AND (ur.private_profile_id = v_dup_author_profile OR ur.public_profile_id = v_dup_author_profile)
  LIMIT 1;

  SELECT COALESCE(u.name, u.email, 'Course staff')
  INTO v_staff_name
  FROM public.users u
  WHERE u.user_id = auth.uid();

  -- Drop watcher rows that would violate (user_id, discussion_thread_root_id) uniqueness after retargeting
  DELETE FROM public.discussion_thread_watchers wdup
  USING public.discussion_thread_watchers worig
  WHERE wdup.discussion_thread_root_id = p_duplicate_root_id
    AND worig.discussion_thread_root_id = p_original_root_id
    AND wdup.user_id = worig.user_id;

  UPDATE public.discussion_thread_watchers
  SET discussion_thread_root_id = p_original_root_id
  WHERE discussion_thread_root_id = p_duplicate_root_id;

  UPDATE public.discussion_thread_read_status
  SET discussion_thread_root_id = p_original_root_id
  WHERE discussion_thread_root_id = p_duplicate_root_id;

  UPDATE public.discussion_threads
  SET
    root = p_original_root_id,
    parent = p_original_root_id,
    topic_id = v_orig_topic_id,
    instructors_only = v_orig_instructors_only,
    root_class_id = NULL,
    duplicate_original_subject = v_dup_subject,
    duplicate_marked_by_user_id = auth.uid(),
    duplicate_marked_by_display_name = v_staff_name,
    duplicate_marked_at = now()
  WHERE id = p_duplicate_root_id;

  UPDATE public.discussion_threads
  SET
    root = p_original_root_id,
    topic_id = v_orig_topic_id,
    instructors_only = v_orig_instructors_only
  WHERE root = p_duplicate_root_id
    AND id != p_duplicate_root_id;

  PERFORM public.recalculate_discussion_thread_children_counts(v_dup_class_id);

  IF v_author_user_id IS NOT NULL AND v_author_user_id IS DISTINCT FROM auth.uid() THEN
    INSERT INTO public.notifications (class_id, subject, body, style, user_id)
    VALUES (
      v_dup_class_id,
      '{}'::jsonb,
      jsonb_build_object(
        'type', 'discussion_thread',
        'action', 'marked_duplicate',
        'root_thread_id', p_original_root_id,
        'duplicate_thread_id', p_duplicate_root_id,
        'original_thread_subject', v_orig_subject,
        'duplicate_original_subject', v_dup_subject,
        'marked_by_user_id', auth.uid(),
        'marked_by_name', v_staff_name,
        'duplicate_thread_ordinal', v_dup_ordinal
      ),
      'info',
      v_author_user_id
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.toggle_discussion_thread_author_anonymity(p_thread_id bigint, p_make_anonymous boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_thread_class_id bigint;
  v_current_author_id uuid;
  v_target_author_id uuid;
  v_user_role_record public.user_roles%ROWTYPE;
  v_is_staff boolean;
  v_thread_root bigint;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);

  -- Get the thread and verify it exists and is a root thread
  SELECT class_id, author, root
  INTO v_thread_class_id, v_current_author_id, v_thread_root
  FROM public.discussion_threads
  WHERE id = p_thread_id;

  IF v_thread_class_id IS NULL THEN
    RAISE EXCEPTION 'Thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Verify this is a root thread (root is NULL or equals id)
  IF v_thread_root IS NOT NULL AND v_thread_root != p_thread_id THEN
    RAISE EXCEPTION 'Can only toggle anonymity for root posts'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Check that the caller holds moderate_discussion in this class (#1010)
  v_is_staff := v_thread_class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'));

  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'Access denied: moderate_discussion required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Find the user_roles record that matches the current author
  -- The author could be either private_profile_id or public_profile_id
  --
  -- Deliberately NOT filtered on disabled = false, unlike the caller check above:
  -- user_roles.private_profile_id and .public_profile_id each carry a table-wide UNIQUE
  -- constraint, so this matches at most one row either way, and omitting the filter lets
  -- staff still fix up posts written by a student whose enrollment was later disabled.
  SELECT *
  INTO v_user_role_record
  FROM public.user_roles
  WHERE class_id = v_thread_class_id
    AND (private_profile_id = v_current_author_id OR public_profile_id = v_current_author_id)
  LIMIT 1;

  IF v_user_role_record IS NULL THEN
    RAISE EXCEPTION 'Could not find user role for thread author'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Determine target profile ID based on p_make_anonymous
  IF p_make_anonymous THEN
    v_target_author_id := v_user_role_record.public_profile_id;
  ELSE
    v_target_author_id := v_user_role_record.private_profile_id;
  END IF;

  -- If already at target state, no-op
  IF v_current_author_id = v_target_author_id THEN
    RETURN;
  END IF;

  -- Take the row locks for the whole thread tree BEFORE the first UPDATE below, whose
  -- AFTER trigger (transfer_discussion_karma_on_author_change) locks rows in `profiles`.
  --
  -- Without this, the two UPDATEs invert the lock order that every other karma path
  -- follows (thread row, then profile row): the root UPDATE's transfer trigger leaves
  -- this transaction holding both profile rows, and the descendant UPDATE then goes back
  -- for more thread rows. A like arriving on a descendant in that window holds the
  -- descendant's thread row (update_thread_likes bumps likes_count) and waits on the old
  -- author's profile row, so the two deadlock and Postgres usually aborts this RPC:
  --
  --   ERROR:  deadlock detected
  --   CONTEXT:  while locking tuple (0,69) in relation "discussion_threads"
  --             SQL statement "UPDATE public.discussion_threads SET author = ... WHERE root = ..."
  --
  -- Claiming every thread row up front restores thread-then-profiles ordering for this
  -- path too. ORDER BY id makes the acquisition order deterministic, so two staff
  -- toggling overlapping trees cannot cycle against each other either.
  PERFORM 1
  FROM public.discussion_threads
  WHERE id = p_thread_id
     OR root = p_thread_id
  ORDER BY id
  FOR UPDATE;

  -- Update the root thread
  UPDATE public.discussion_threads
  SET author = v_target_author_id
  WHERE id = p_thread_id;

  -- Update all descendant threads (replies) by the same user
  -- We need to find all threads where:
  -- 1. root = p_thread_id (they're part of this thread tree)
  -- 2. author matches either the old private or public profile ID (same user)
  UPDATE public.discussion_threads
  SET author = v_target_author_id
  WHERE root = p_thread_id
    AND id != p_thread_id  -- Don't update the root again
    AND author IN (v_user_role_record.private_profile_id, v_user_role_record.public_profile_id);

END;
$function$;

CREATE OR REPLACE FUNCTION public.set_discussion_thread_visibility(p_thread_id bigint, p_instructors_only boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_thread_class_id bigint;
  v_thread_root bigint;
  v_thread_author text;
  v_is_staff boolean;
  v_is_author boolean;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  
  -- Get the thread and verify it exists
  SELECT class_id, root, author
  INTO v_thread_class_id, v_thread_root, v_thread_author
  FROM public.discussion_threads
  WHERE id = p_thread_id;
  
  IF v_thread_class_id IS NULL THEN
    RAISE EXCEPTION 'Thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  
  -- Verify this is a root thread (root is NULL or equals id)
  IF v_thread_root IS NOT NULL AND v_thread_root != p_thread_id THEN
    RAISE EXCEPTION 'Can only set visibility for root posts'
      USING ERRCODE = 'check_violation';
  END IF;
  
  -- Check if the caller holds moderate_discussion in this class (#1010)
  v_is_staff := v_thread_class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'));
  
  -- Check if the caller is the author of the thread
  -- Cast v_thread_author (text) to uuid for comparison with profile IDs
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND class_id = v_thread_class_id
      AND disabled = false
      AND (private_profile_id = v_thread_author::uuid OR public_profile_id = v_thread_author::uuid)
  ) INTO v_is_author;
  
  -- Check that the caller is either staff or the author
  IF NOT (v_is_staff OR v_is_author) THEN
    RAISE EXCEPTION 'Access denied: Must hold moderate_discussion or be the thread author'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  
  -- Update the root thread and all descendant threads atomically
  -- All updates happen in a single transaction (implicit)
  UPDATE public.discussion_threads
  SET instructors_only = p_instructors_only
  WHERE id = p_thread_id;
  
  -- Update all descendant threads (replies) to match the root visibility
  UPDATE public.discussion_threads
  SET instructors_only = p_instructors_only
  WHERE root = p_thread_id
    AND id != p_thread_id;  -- Don't update the root again
  
END;
$function$;

REVOKE ALL ON FUNCTION public.set_discussion_thread_topic(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_discussion_thread_topic(bigint, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_discussion_thread_duplicate(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_discussion_thread_duplicate(bigint, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.toggle_discussion_thread_author_anonymity(bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_discussion_thread_author_anonymity(bigint, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_discussion_thread_visibility(bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_discussion_thread_visibility(bigint, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Pinning, answers and topics
-- ---------------------------------------------------------------------------

-- The author rule above lets an author update every column of their own post. This keeps pinning
-- and topic changes to moderators, and marking an answer to the question's author and moderators,
-- with the answer a reply in the same thread. A new post can start pinned only if its author is a
-- moderator, and can never start with an answer (it has no replies yet). No signed-in user can move
-- a post to another class. Moving a topic through set_discussion_thread_topic or
-- mark_discussion_thread_duplicate still works: both need moderate_discussion already. Writes with no
-- signed-in user (service role, migrations) aren't checked; no edge function or migration writes
-- these columns today.
CREATE OR REPLACE FUNCTION public.discussion_threads_guard_moderation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_moderator boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.answer IS NOT NULL THEN
      RAISE EXCEPTION 'A new post can''t start with an answer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_is_moderator := NEW.class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'));
    IF NEW.pinned AND NOT v_is_moderator THEN
      RAISE EXCEPTION 'Only a discussion moderator can create a pinned post'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- A post stays in its class, for every signed-in user. Changing class_id and author together
  -- would otherwise let someone enrolled in two classes move a post between them.
  IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
    RAISE EXCEPTION 'A discussion post can''t move to another class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE: the moderator check is for the post's class.
  v_is_moderator := OLD.class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'));

  IF NEW.pinned IS DISTINCT FROM OLD.pinned AND NOT v_is_moderator THEN
    RAISE EXCEPTION 'Only a discussion moderator can pin or unpin a post'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.topic_id IS DISTINCT FROM OLD.topic_id AND NOT v_is_moderator THEN
    RAISE EXCEPTION 'Only a discussion moderator can move a post to another topic'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.answer IS DISTINCT FROM OLD.answer THEN
    IF NOT v_is_moderator AND NOT EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = v_uid
        AND up.class_id = OLD.class_id
        AND OLD.author IN (up.public_profile_id, up.private_profile_id)
    ) THEN
      RAISE EXCEPTION 'Only the question''s author or a discussion moderator can mark an answer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.answer IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.discussion_threads r
      WHERE r.id = NEW.answer
        AND r.root = OLD.id
        AND r.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'An answer must be a reply in the same thread'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.discussion_threads_guard_moderation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS discussion_threads_guard_moderation ON public.discussion_threads;
CREATE TRIGGER discussion_threads_guard_moderation
  BEFORE INSERT OR UPDATE OF pinned, answer, topic_id, class_id ON public.discussion_threads
  FOR EACH ROW EXECUTE FUNCTION public.discussion_threads_guard_moderation();
