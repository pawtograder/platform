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
--   5. Pinning, answers, topics, threads and classes: an author could update every column of their
--      own post, so a student could pin it, set its answer to anything, move it to another topic,
--      move it under another thread or move it into another class through the API. Now only a
--      moderator can pin or unpin, change a post's topic, move a post under another thread (its root
--      or parent), or create a pinned post; no new post can start with an answer (it has no replies
--      yet); only the question's author or a moderator can mark or unmark an answer, and the answer
--      must be a reply in that thread; and no signed-in user can move a post to another class.
--      Also for everyone signed in: a post's topic must be in its class, and its author can only
--      switch between the same person's named and anonymous profile. mark_discussion_thread_duplicate
--      refuses to merge a private and a public thread.
--   6. Columns only the database sets: signed-in users can't set a post's created_at, likes_count,
--      children_count, ordinal or duplicate_* fields; root_class_id and edited_at are set by the
--      guard.
--   7. Likes: only on a post the user can see in their class, and a like can't be moved.
--   8. Watches: a turned-on watch must be on a thread the user can see in its class, and reply
--      notifications go only to watchers enrolled in the class.
--   9. Discord: a private post is never sent to the class's Discord channel.
--  10. Replies: a new reply's parent must be a post the user can see in the same class, and its
--      root must be that post's thread, so nobody posts into a thread they can't read.
--
-- Not changed: reading threads, posting, follows, read status, discussion topics, error pins, AI
-- help and discussion engagement.
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

  -- The merge gives the duplicate and its replies the original's visibility, so a private post
  -- merged into a public one would be shown to the whole class (#1010).
  IF (SELECT dt.instructors_only FROM public.discussion_threads dt WHERE dt.id = p_duplicate_root_id)
     IS DISTINCT FROM v_orig_instructors_only THEN
    RAISE EXCEPTION 'A private and a public thread can''t be merged'
      USING ERRCODE = 'invalid_parameter_value';
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
-- 5. Pinning, answers, topics and threads
-- ---------------------------------------------------------------------------

-- The author rule above lets an author update every column of their own post. This keeps pinning,
-- topic changes and moving a post under another thread (root or parent, in the same class) to
-- moderators, and marking an answer to the question's author and moderators,
-- with the answer a reply in the same thread. A new post can start pinned only if its author is a
-- moderator, and can never start with an answer (it has no replies yet). No signed-in user can move
-- a post to another class. A new question still gets its root set to itself: the
-- discussion_threads_notification() trigger does that right after the insert, as the poster.
-- Moving a topic or thread through set_discussion_thread_topic or mark_discussion_thread_duplicate
-- still works: both need moderate_discussion already. Writes with no
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
    IF NEW.topic_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.discussion_topics t WHERE t.id = NEW.topic_id AND t.class_id = NEW.class_id
    ) THEN
      RAISE EXCEPTION 'A post''s topic must be in the post''s class'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- root_class_id marks a class's questions (DiscussionSummary lists them by it): the class for a
    -- new question, empty for a reply. The client sends it, so it is set here instead of trusted.
    NEW.root_class_id := CASE WHEN NEW.parent IS NULL THEN NEW.class_id END;
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

  IF NEW.topic_id IS DISTINCT FROM OLD.topic_id THEN
    IF NOT v_is_moderator THEN
      RAISE EXCEPTION 'Only a discussion moderator can move a post to another topic'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.topic_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.discussion_topics t WHERE t.id = NEW.topic_id AND t.class_id = OLD.class_id
    ) THEN
      RAISE EXCEPTION 'A post''s topic must be in the post''s class'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- The author can only switch between the two profiles (named and anonymous) of the same person
  -- in this class, for everyone signed in: a moderator can't hand a post to someone else.
  -- toggle_discussion_thread_author_anonymity makes exactly this switch.
  IF NEW.author IS DISTINCT FROM OLD.author AND NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.class_id = OLD.class_id
      AND OLD.author IN (ur.private_profile_id, ur.public_profile_id)
      AND NEW.author IN (ur.private_profile_id, ur.public_profile_id)
  ) THEN
    RAISE EXCEPTION 'A post''s author can only switch between their own named and anonymous profile'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The edit time is the server's, not the client's.
  IF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    NEW.edited_at := now() AT TIME ZONE 'UTC';
  END IF;

  -- Moving a post under another thread. The one change allowed for everyone is a new question's
  -- root going from empty to its own id (see the comment above this function).
  IF (
    (NEW.root IS DISTINCT FROM OLD.root AND NOT (OLD.root IS NULL AND NEW.root = OLD.id))
    OR NEW.parent IS DISTINCT FROM OLD.parent
  ) AND NOT v_is_moderator THEN
    RAISE EXCEPTION 'Only a discussion moderator can move a post under another thread'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Moderators included: the thread a post moves under must be in the post's class. Only class_id
  -- is read, which no update changes, so this doesn't depend on the order mark_discussion_thread_duplicate
  -- re-roots replies in.
  IF (NEW.root IS DISTINCT FROM OLD.root OR NEW.parent IS DISTINCT FROM OLD.parent) AND EXISTS (
    SELECT 1
    FROM public.discussion_threads target
    WHERE target.id IN (NEW.root, NEW.parent)
      AND target.class_id IS DISTINCT FROM OLD.class_id
  ) THEN
    RAISE EXCEPTION 'A post can''t move under a thread in another class'
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
  BEFORE INSERT OR UPDATE OF pinned, answer, topic_id, class_id, root, parent, author, edited_at
  ON public.discussion_threads
  FOR EACH ROW EXECUTE FUNCTION public.discussion_threads_guard_moderation();

-- ---------------------------------------------------------------------------
-- 6. Columns only the database sets
-- ---------------------------------------------------------------------------

-- RLS can't limit which columns change, so column privileges do. Signed-in users can no longer set
-- a post's id, created_at, updated_at, likes_count, children_count, ordinal or duplicate_* fields,
-- or change root_class_id. The database's own functions and triggers still set them (they run as
-- their owner). The app writes only the columns granted here: a new post or reply (new/page.tsx,
-- discussion_thread.tsx), an edit (body, edited_at, instructors_only), pinning, answers and the
-- RPCs. root_class_id and edited_at are still accepted, but the guard above sets their value.
-- TRUNCATE skips RLS, so it goes too (same as 20261030120000_protect_class_roles.sql).
REVOKE INSERT, UPDATE, TRUNCATE ON public.discussion_threads FROM anon, authenticated;
GRANT INSERT (
  author, subject, body, instructors_only, is_question, answer, class_id, parent, root, draft,
  topic_id, pinned, root_class_id
) ON public.discussion_threads TO authenticated;
GRANT UPDATE (
  author, subject, body, instructors_only, is_question, answer, class_id, parent, root, draft,
  topic_id, pinned, edited_at
) ON public.discussion_threads TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Likes: only on a post you can see, in your class
-- ---------------------------------------------------------------------------

-- Before, "CRUD for own only" checked only that the like was yours, so a like could go on any post
-- (another class's, or a private one) and an existing like could be moved to another post. A like
-- is now added or removed, never changed, and only on a post the user can see in a class they're in
-- (the subquery on discussion_threads runs under its own RLS).
DROP POLICY IF EXISTS "CRUD for own only" ON public.discussion_thread_likes;
DROP POLICY IF EXISTS "Likes: read own" ON public.discussion_thread_likes;
DROP POLICY IF EXISTS "Likes: add own on a visible post" ON public.discussion_thread_likes;
DROP POLICY IF EXISTS "Likes: remove own" ON public.discussion_thread_likes;

CREATE POLICY "Likes: read own" ON public.discussion_thread_likes
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_privileges up
    WHERE up.user_id = (SELECT auth.uid())
      AND discussion_thread_likes.creator IN (up.public_profile_id, up.private_profile_id)
  ));

CREATE POLICY "Likes: add own on a visible post" ON public.discussion_thread_likes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.user_privileges up
    JOIN public.discussion_threads t ON t.class_id = up.class_id
    WHERE up.user_id = (SELECT auth.uid())
      AND discussion_thread_likes.creator IN (up.public_profile_id, up.private_profile_id)
      AND t.id = discussion_thread_likes.discussion_thread
  ));

CREATE POLICY "Likes: remove own" ON public.discussion_thread_likes
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_privileges up
    WHERE up.user_id = (SELECT auth.uid())
      AND discussion_thread_likes.creator IN (up.public_profile_id, up.private_profile_id)
  ));

REVOKE UPDATE, TRUNCATE ON public.discussion_thread_likes FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Watching a thread, and who is notified of replies
-- ---------------------------------------------------------------------------

-- Before, "CRUD for self" checked only that the watch was yours, so someone could watch a thread in
-- another class (or a private thread) and be notified of every reply with its text. A turned-on
-- watch must now be on a thread the user can see, in the class it names (the subquery runs under
-- discussion_threads' RLS). Turning a watch off always works. The automatic watch when someone posts
-- is written by discussion_threads_notification(), which runs as its owner.
DROP POLICY IF EXISTS "CRUD for self" ON public.discussion_thread_watchers;
CREATE POLICY "CRUD for self" ON public.discussion_thread_watchers
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND (
      NOT enabled
      OR EXISTS (
        SELECT 1 FROM public.discussion_threads t
        WHERE t.id = discussion_thread_watchers.discussion_thread_root_id
          AND t.root = t.id
          AND t.class_id = discussion_thread_watchers.class_id
      )
    )
  );

REVOKE TRUNCATE ON public.discussion_thread_watchers FROM anon, authenticated;

-- Reply notifications go only to watchers enrolled in the class. Re-created from the live body
-- (20260317000000_filter_instructors_only_and_add_message_body.sql); only that filter is new.
CREATE OR REPLACE FUNCTION public.discussion_threads_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   root_subject text;
   reply_author_name text;
   current_user_id uuid;
   is_new_post boolean;
   thread_topic_id bigint;
   notification_reason text;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
    -- Set root to its own ID if there is no root specified
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
         NEW.root = NEW.id;
         root_subject = NEW.subject;
      else
        SELECT discussion_threads.subject from discussion_threads into root_subject WHERE id=NEW.root;
      end if;

      -- Determine if this is a new post (root = id) or a reply
      is_new_post := (NEW.root = NEW.id);

      -- Get the topic_id for this thread
      SELECT topic_id INTO thread_topic_id FROM discussion_threads WHERE id = NEW.root;

      SELECT name into reply_author_name from profiles where id=NEW.author;

   -- Get current user ID, handling null case
      current_user_id := auth.uid();

   -- Build notification body with appropriate action and reason
      if is_new_post then
        -- New post: notify topic followers
        notification_reason := 'topic_follow';
        body := jsonb_build_object(
           'type', 'discussion_thread',
           'action', 'new_post',
           'new_comment_number', NEW.ordinal,
           'new_comment_id', NEW.id,
           'root_thread_id', NEW.root,
           'reply_author_profile_id', NEW.author,
           'teaser', left(NEW.body, 40),
           'message_body', left(NEW.body, 1000),
           'thread_name', root_subject,
           'reply_author_name', reply_author_name,
           'topic_id', thread_topic_id,
           'notification_reason', notification_reason
        );
      else
        -- Reply: notify thread watchers
        notification_reason := 'thread_watch';
        body := jsonb_build_object(
           'type', 'discussion_thread',
           'action', 'reply',
           'new_comment_number', NEW.ordinal,
           'new_comment_id', NEW.id,
           'root_thread_id', NEW.root,
           'reply_author_profile_id', NEW.author,
           'teaser', left(NEW.body, 40),
           'message_body', left(NEW.body, 1000),
           'thread_name', root_subject,
           'reply_author_name', reply_author_name,
           'topic_id', thread_topic_id,
           'notification_reason', notification_reason
        );
      end if;

      subject := '{}';
      style := 'info';

      -- Only send notifications if we have a current user
      if current_user_id is not null then
        if is_new_post then
          -- For new posts: notify users who follow the topic (and don't have notifications disabled)
          -- For instructors_only threads: only notify instructors and graders, not students
          -- Follow logic: if topic has default_follow=true, user follows unless override with following=false
          --                if topic has default_follow=false, user follows only if override with following=true
          INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT DISTINCT
            NEW.class_id,
            subject,
            body,
            style,
            ur.user_id
          FROM user_roles ur
          JOIN discussion_topics dt ON dt.id = thread_topic_id AND dt.class_id = NEW.class_id
          LEFT JOIN discussion_topic_followers dtf ON dtf.user_id = ur.user_id
            AND dtf.topic_id = thread_topic_id
            AND dtf.class_id = NEW.class_id
          WHERE ur.class_id = NEW.class_id
            AND ur.user_id != current_user_id
            -- User follows if: (default_follow=true AND no override OR override with following=true)
            --                OR (default_follow=false AND override with following=true)
            AND (
              (dt.default_follow = true AND (dtf.id IS NULL OR dtf.following = true))
              OR (dt.default_follow = false AND dtf.following = true)
            )
            -- For instructors_only threads: only notify staff (instructors and graders)
            AND (
              (NOT COALESCE((SELECT dt2.instructors_only FROM discussion_threads dt2 WHERE dt2.id = NEW.root), false))
              OR (ur.role IN ('instructor', 'grader'))
            )
            -- Check notification preferences - only send if not disabled
            AND NOT EXISTS (
              SELECT 1 FROM notification_preferences np
              WHERE np.user_id = ur.user_id
                AND np.class_id = NEW.class_id
                AND np.discussion_notification = 'disabled'
            );
        else
          -- For replies: notify thread watchers (existing behavior)
          -- For instructors_only threads: only notify staff (instructor, grader), not students
          INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT NEW.class_id, subject, body, style, discussion_thread_watchers.user_id
          FROM discussion_thread_watchers
          WHERE discussion_thread_root_id = NEW.root
            AND enabled = true
            AND user_id != current_user_id
            -- Only people enrolled in the class (#1010): a watch row can't reach another class
            AND EXISTS (
              SELECT 1 FROM user_roles ur_enrolled
              WHERE ur_enrolled.user_id = discussion_thread_watchers.user_id
                AND ur_enrolled.class_id = NEW.class_id
                AND ur_enrolled.disabled = false
            )
            -- For instructors_only threads: only notify staff
            AND (
              (NOT COALESCE((SELECT dt.instructors_only FROM discussion_threads dt WHERE dt.id = NEW.root), false))
              OR EXISTS (
                SELECT 1 FROM user_roles ur
                WHERE ur.user_id = discussion_thread_watchers.user_id
                  AND ur.class_id = NEW.class_id
                  AND ur.role IN ('instructor', 'grader')
                  AND ur.disabled = false
              )
            )
            -- Check notification preferences - only send if not disabled
            AND NOT EXISTS (
              SELECT 1 FROM notification_preferences np
              WHERE np.user_id = discussion_thread_watchers.user_id
                AND np.class_id = NEW.class_id
                AND np.discussion_notification = 'disabled'
            );
        end if;
      end if;

   -- Set watch if there is not one already and we have a current user
      if current_user_id is not null then
        INSERT INTO discussion_thread_watchers (class_id, discussion_thread_root_id, user_id, enabled)
        VALUES (NEW.class_id, NEW.root, current_user_id, true)
        ON CONFLICT (user_id, discussion_thread_root_id) DO NOTHING;
      end if;

      -- Mark as unread for everyone in the class, excluding the current user if one exists
      if current_user_id is not null then
        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id)
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id
        from user_roles
        where class_id = NEW.class_id and user_id != current_user_id;

        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id, read_at)
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id, NEW.created_at as read_at
        from user_roles
        where class_id = NEW.class_id and user_id = current_user_id;
      else
        -- If no current user (seeding context), mark as unread for all users in the class
        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id)
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id
        from user_roles
        where class_id = NEW.class_id;
      end if;

   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;

   RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------
-- 9. Discord: never a private post
-- ---------------------------------------------------------------------------

-- A private (instructors_only) question was posted to the class's Discord channel when created,
-- published from a draft or answered. This skips private posts on all three paths, since they all
-- call this function. Re-created from the live body (20260105120000_discord_discussion_integration.sql);
-- only the instructors_only filter is new.
CREATE OR REPLACE FUNCTION public.enqueue_discord_discussion_thread_message(p_thread_id bigint, p_action text DEFAULT 'created'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_thread RECORD;
  v_topic RECORD;
  v_class RECORD;
  v_author_name text;
  v_message_content text;
  v_embed jsonb;
  v_status_color integer;
  v_type_emoji text;
  v_type_label text;
  v_answered_text text;
  v_existing_message_id text;
BEGIN
  -- Get thread details
  SELECT 
    dt.id,
    dt.class_id,
    dt.topic_id,
    dt.subject,
    dt.body,
    dt.is_question,
    dt.answer,
    dt.author,
    dt.instructors_only,
    dt.likes_count,
    dt.children_count,
    dt.created_at
  INTO v_thread
  FROM public.discussion_threads dt
  WHERE dt.id = p_thread_id
    AND dt.parent IS NULL  -- Root threads have no parent
    AND dt.draft = false -- Only published threads
    AND dt.instructors_only = false; -- Never a private post (#1010)

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Get topic details including discord_channel_id
  SELECT 
    dtp.id,
    dtp.topic,
    dtp.discord_channel_id
  INTO v_topic
  FROM public.discussion_topics dtp
  WHERE dtp.id = v_thread.topic_id;

  IF NOT FOUND OR v_topic.discord_channel_id IS NULL THEN
    -- Topic not linked to Discord channel
    RETURN;
  END IF;

  -- Get class Discord info
  SELECT c.discord_server_id, c.slug, c.name
  INTO v_class
  FROM public.classes c
  WHERE c.id = v_thread.class_id;

  -- Skip if no Discord server configured
  IF v_class.discord_server_id IS NULL THEN
    RETURN;
  END IF;

  -- Get author name (use public profile name, or 'Anonymous' if not available)
  SELECT COALESCE(p.name, 'Anonymous')
  INTO v_author_name
  FROM public.profiles p
  WHERE p.id = v_thread.author;

  IF v_author_name IS NULL THEN
    v_author_name := 'Anonymous';
  END IF;

  -- Determine type emoji and label
  IF v_thread.is_question THEN
    v_type_emoji := '❓';
    v_type_label := 'Question';
  ELSE
    v_type_emoji := '📝';
    v_type_label := 'Note';
  END IF;

  -- Determine status color
  -- Blue for notes, orange for unanswered questions, green for answered questions
  IF NOT v_thread.is_question THEN
    v_status_color := 3447003; -- Blue
  ELSIF v_thread.answer IS NOT NULL THEN
    v_status_color := 3066993; -- Green (answered)
  ELSE
    v_status_color := 15105570; -- Orange (unanswered question)
  END IF;

  -- Build answered status text
  IF v_thread.is_question THEN
    IF v_thread.answer IS NOT NULL THEN
      v_answered_text := '✅ Answered';
    ELSE
      v_answered_text := '⏳ Awaiting Answer';
    END IF;
  ELSE
    v_answered_text := NULL;
  END IF;

  -- Build message content
  IF p_action = 'created' THEN
    v_message_content := format('**New %s in %s**', v_type_label, v_topic.topic);
  ELSIF p_action = 'answered' THEN
    v_message_content := format('**%s Answered in %s**', v_type_label, v_topic.topic);
  ELSIF p_action = 'updated' THEN
    v_message_content := format('**%s Updated in %s**', v_type_label, v_topic.topic);
  ELSE
    v_message_content := format('**%s %s in %s**', v_type_label, UPPER(p_action), v_topic.topic);
  END IF;

  -- Build embed
  v_embed := jsonb_build_object(
    'title', format('%s %s', v_type_emoji, v_thread.subject),
    'description', LEFT(COALESCE(v_thread.body, 'No content'), 500),
    'color', v_status_color,
    'fields', jsonb_build_array(
      jsonb_build_object('name', 'Author', 'value', v_author_name, 'inline', true),
      jsonb_build_object('name', 'Type', 'value', format('%s %s', v_type_emoji, v_type_label), 'inline', true)
    ),
    'footer', jsonb_build_object('text', format('Thread #%s | Topic: %s', v_thread.id, v_topic.topic)),
    'timestamp', v_thread.created_at::text
  );

  -- Add answered status for questions
  IF v_answered_text IS NOT NULL THEN
    v_embed := jsonb_set(
      v_embed,
      '{fields}',
      (v_embed->'fields') || jsonb_build_object(
        'name', 'Status', 
        'value', v_answered_text, 
        'inline', true
      )
    );
  END IF;

  -- Add stats field
  v_embed := jsonb_set(
    v_embed,
    '{fields}',
    (v_embed->'fields') || jsonb_build_object(
      'name', 'Stats', 
      'value', format('💬 %s replies | ❤️ %s likes', COALESCE(v_thread.children_count, 0), COALESCE(v_thread.likes_count, 0)), 
      'inline', false
    )
  );

  -- Check if message already exists (for updates)
  SELECT dm.discord_message_id
  INTO v_existing_message_id
  FROM public.discord_messages dm
  WHERE dm.class_id = v_thread.class_id
    AND dm.resource_type::text = 'discussion_thread'
    AND dm.resource_id = p_thread_id;

  IF v_existing_message_id IS NOT NULL THEN
    -- Update existing message
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'update_message',
        'args', jsonb_build_object(
          'channel_id', v_topic.discord_channel_id,
          'message_id', v_existing_message_id,
          'content', v_message_content,
          'embeds', jsonb_build_array(v_embed)
        ),
        'class_id', v_thread.class_id,
        'resource_type', 'discussion_thread',
        'resource_id', p_thread_id
      )
    );
    RETURN;
  END IF;

  -- Send new message (only if no existing message was found)
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'send_message',
      'args', jsonb_build_object(
        'channel_id', v_topic.discord_channel_id,
        'content', v_message_content,
        'embeds', jsonb_build_array(v_embed)
      ),
      'class_id', v_thread.class_id,
      'resource_type', 'discussion_thread',
      'resource_id', p_thread_id
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_discord_discussion_thread_message(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_discussion_thread_message(bigint, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. A new reply must be in a thread its author can see
-- ---------------------------------------------------------------------------

-- A reply's root and parent came straight from the client. Someone could post a "reply" into a
-- private thread or another class's thread they can't see. authorize_for_private_discussion_thread()
-- then let them read the whole private thread (they had a post in it), and the insert also watched the
-- thread for them and bumped its reply count. Now, on a signed-in user's insert:
--   - a new question (no parent) can't name another thread as its root;
--   - a reply's parent must be a post the user can see, in the same class, and its root must be the
--     parent's thread.
-- This function is SECURITY INVOKER on purpose: it runs as the signed-in user, so reading the parent
-- follows discussion_threads' own SELECT policy, with no copy of its rules here. Writes with no
-- signed-in user (service role, seeding) aren't checked.
CREATE OR REPLACE FUNCTION public.discussion_threads_guard_reply_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_parent_class_id bigint;
  v_parent_root bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent IS NULL THEN
    IF NEW.root IS NOT NULL AND NEW.root IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'A new question can''t be part of another thread'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  SELECT p.class_id, COALESCE(p.root, p.id)
  INTO v_parent_class_id, v_parent_root
  FROM public.discussion_threads p
  WHERE p.id = NEW.parent;

  IF NOT FOUND OR v_parent_class_id IS DISTINCT FROM NEW.class_id THEN
    RAISE EXCEPTION 'A reply must be to a post you can see in the same class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.root IS DISTINCT FROM v_parent_root THEN
    RAISE EXCEPTION 'A reply must be in the same thread as the post it answers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.discussion_threads_guard_reply_target() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS discussion_threads_guard_reply_target ON public.discussion_threads;
CREATE TRIGGER discussion_threads_guard_reply_target
  BEFORE INSERT ON public.discussion_threads
  FOR EACH ROW EXECUTE FUNCTION public.discussion_threads_guard_reply_target();
