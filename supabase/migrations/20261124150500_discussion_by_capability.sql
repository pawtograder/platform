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
--      capabilities of open PRs (#1301, #1408, #1409, #1410) without failing, and whichever of
--      those merges first doesn't lose the others'. It keeps those of #1299 and #1300, which merged. Keep the list complete when a
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
--      moderator can pin or unpin, change a post's topic, or create a pinned post; a post only moves
--      under another thread through mark_discussion_thread_duplicate; no new post can start with an
--      answer (it has no replies yet); only the question's author or a moderator can mark or unmark an
--      answer, and the answer must be a reply in that thread; and no signed-in user can move a post to
--      another class. Also for everyone signed in: a post's topic must be in its class, and its author
--      can only switch between the same person's named and anonymous profile.
--      mark_discussion_thread_duplicate merges only public threads, and keeps a private reply private.
--   6. Columns only the database sets: signed-in users can't set a post's created_at, likes_count,
--      children_count, ordinal or duplicate_* fields; root_class_id and edited_at are set by the
--      guard.
--   7. Likes: only on a post the user can see in their class, and a like can't be moved.
--   8. Watches: a turned-on watch must be on a thread the user can see in its class, and reply
--      notifications go only to watchers enrolled in the class.
--   9. Discord: a private post isn't queued for the class's Discord channel, and the Discord worker
--      re-checks a queued message before sending it, and once more after. When a thread is made
--      private, its Discord message is deleted; when it is made public, it is posted; when its
--      subject, text or shown author changes, the message is updated in the channel it is in.
--  10. Replies: a new reply's parent must be a post the user can see in the same class, and its
--      root must be that post's thread, so nobody posts into a thread they can't read.
--  11. A reply in a private thread is always private, and only set_discussion_thread_visibility on
--      a root changes a post's visibility. A post only moves to another thread through Mark
--      Duplicate. Existing public replies in private threads become private. Making a thread private
--      marks the replies it hides (hidden_with_thread), and making it public again shows only those,
--      so a reply that was private before stays private.
--  12. Reading private posts: a private post is readable by staff, its own author and, when the
--      thread's question is private, the question's author. Anyone else with a post in the thread
--      could read it before. Realtime, reply notifications, unread marks and the email digest follow
--      the same rule: a private row is sent to the thread's channel as its id only, and each viewer
--      re-reads it under this rule.
--  13. Older gaps on the same tables: new-post notifications skip disabled enrollments; read-status
--      rows for a private post go only to the people who can read it; error-pin matches leave out
--      private threads; an error pin's thread must be in the pin's class; a topic can't move to
--      another class; a like is made with your own (named) profile and not on your own post; and
--      two unused tables (discussion_thread_watcher_cache, which showed who watches each thread,
--      and discussion_thread_ordinal_counters, writable by anyone) are dropped.
--  14. Locks: thread moves, merges, visibility changes and new replies lock the thread's question
--      row first, so two of them can't interleave and leave a reply with the wrong visibility.
--  15. Counts: children_count counts only the replies every reader of the question can read, and
--      unread marks of posts someone can't read are removed.
--
-- Not changed: posting, follows, discussion topics' other rules, AI help and discussion engagement.
--
-- Run once. The role backfill in section 1 is for the first rollout only: running it again would
-- put moderate_discussion back on every role an instructor has taken it off.

-- Each migration file runs in one transaction (psql --single-transaction in the deploy image, and
-- the supabase CLI). This one takes locks on discussion_threads and its neighbours; wait at most
-- 10 seconds for one, then fail instead of queueing every reader behind it.
SET LOCAL lock_timeout = '10s';

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
-- be the author's own post in its class.
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
  WITH CHECK (public.authorizeforprofile_in_class(author, class_id));

-- ---------------------------------------------------------------------------
-- 4. The moderation functions: latest bodies, only the permission check changes
-- ---------------------------------------------------------------------------

-- A reply that is private only because its thread is private (#1010). Making the thread private sets
-- it on the replies it hides, and making the thread public again shows only those, so a reply that
-- was private on its own stays private. Only the database sets it (no column grant below).
ALTER TABLE public.discussion_threads
  ADD COLUMN IF NOT EXISTS hidden_with_thread boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.discussion_threads.hidden_with_thread IS
  'True when this reply is private only because its thread is private; set by the database.';

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
  
  -- Get the thread and verify it exists. Locked first (#1010), like every other path that changes a
  -- whole thread, so the root is always the first row taken.
  SELECT class_id, root
  INTO v_thread_class_id, v_thread_root
  FROM public.discussion_threads
  WHERE id = p_thread_id
  FOR NO KEY UPDATE;
  
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
  v_dup_instructors_only boolean;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  -- SECURITY DEFINER still applies RLS as the invoker; disable for this body so
  -- discussion_threads SELECT policy cannot recurse (42P17) during root/parent updates.
  PERFORM set_config('row_security', 'off', true);

  IF p_duplicate_root_id = p_original_root_id THEN
    RAISE EXCEPTION 'Cannot mark a thread as a duplicate of itself'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lock both questions, in id order so two merges can't deadlock, before reading anything (#1010).
  -- Every check below then reads the locked rows: a reply posted, or a visibility change made, while
  -- this runs waits for it, and a reply aimed at the duplicate after it commits is refused by the
  -- reply guard (its parent has moved to the original's thread).
  PERFORM 1
  FROM public.discussion_threads dt
  WHERE dt.id IN (p_duplicate_root_id, p_original_root_id)
  ORDER BY dt.id
  FOR NO KEY UPDATE;

  SELECT dt.class_id, dt.root, dt.subject, dt.author, dt.ordinal, dt.instructors_only
  INTO v_dup_class_id, v_dup_root, v_dup_subject, v_dup_author_profile, v_dup_ordinal, v_dup_instructors_only
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

  -- The caller must hold moderate_discussion in the class (#1010)
  IF NOT (v_dup_class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'))) THEN
    RAISE EXCEPTION 'Access denied: moderate_discussion required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only public threads merge (#1010). Merging a private thread shows its posts to the other
  -- thread's readers, now or when that thread is made public later.
  IF v_dup_instructors_only OR v_orig_instructors_only THEN
    RAISE EXCEPTION 'A private thread can''t be merged'
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
    root_class_id = NULL,
    duplicate_original_subject = v_dup_subject,
    duplicate_marked_by_user_id = auth.uid(),
    duplicate_marked_by_display_name = v_staff_name,
    duplicate_marked_at = now()
  WHERE id = p_duplicate_root_id;

  -- A private reply stays private (#1010): the threads are public, so replies keep their own visibility.
  UPDATE public.discussion_threads
  SET
    root = p_original_root_id,
    topic_id = v_orig_topic_id
  WHERE root = p_duplicate_root_id
    AND id != p_duplicate_root_id;

  -- No class-wide recount (#1010): it locked every question in the class, so two merges in one
  -- class could deadlock. The reply-count trigger (section 15) recounts the two threads that changed.

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
  -- Deliberately NOT filtered on disabled = false:
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
  --
  -- The root comes first (#1010): a new reply and the other thread-wide functions lock the root
  -- before any reply, so taking replies first could cycle against them.
  PERFORM 1
  FROM public.discussion_threads
  WHERE id = p_thread_id
     OR root = p_thread_id
  ORDER BY (id <> p_thread_id), id
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
  v_current_instructors_only boolean;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  
  -- Get the thread and verify it exists. Locked (#1010): a reply being posted locks the same row
  -- first, so it either lands before this change (and is updated below) or after it (and the reply
  -- guard reads the new visibility). Two clicks at once also run one after the other.
  SELECT class_id, root, author, instructors_only
  INTO v_thread_class_id, v_thread_root, v_thread_author, v_current_instructors_only
  FROM public.discussion_threads
  WHERE id = p_thread_id
  FOR NO KEY UPDATE;
  
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
  
  -- Nothing to do when the thread already has this visibility. Otherwise the replies update below
  -- would make a public thread's private replies public (#1010).
  IF v_current_instructors_only IS NOT DISTINCT FROM p_instructors_only THEN
    RETURN;
  END IF;

  -- Update the root thread and all descendant threads atomically
  -- All updates happen in a single transaction (implicit)
  UPDATE public.discussion_threads
  SET instructors_only = p_instructors_only
  WHERE id = p_thread_id;
  
  -- The replies (#1010). Making the thread private hides its public replies and marks them
  -- hidden_with_thread. Making it public shows only the marked ones, so a reply that was private
  -- before the thread was hidden stays private. Before, every reply took the thread's visibility.
  IF p_instructors_only THEN
    UPDATE public.discussion_threads
    SET instructors_only = true,
        hidden_with_thread = true
    WHERE root = p_thread_id
      AND id != p_thread_id
      AND NOT instructors_only;
    -- Unread marks of the people who can't read the thread now go (section 15).
    PERFORM public.prune_discussion_thread_read_status(p_thread_id);
  ELSE
    UPDATE public.discussion_threads
    SET instructors_only = false,
        hidden_with_thread = false
    WHERE root = p_thread_id
      AND id != p_thread_id
      AND hidden_with_thread;
  END IF;

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

-- The author rule above lets an author update their own post's columns that signed-in users may
-- write (section 6: not its thread, class or visibility). This keeps pinning and topic changes to
-- moderators, and marking an answer to the question's author and moderators, with the answer a reply
-- in the same thread. A new post can start pinned only if its author is a moderator, and can never
-- start with an answer (it has no replies yet). The author can only switch between the same person's
-- named and anonymous profile. Writes with no signed-in user (service role, migrations) aren't
-- checked.
CREATE OR REPLACE FUNCTION public.discussion_threads_guard_moderation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_moderator boolean;
  v_root_topic_id bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.answer IS NOT NULL THEN
      RAISE EXCEPTION 'A new post can''t start with an answer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.pinned AND NOT (NEW.class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'))) THEN
      RAISE EXCEPTION 'Only a discussion moderator can create a pinned post'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A reply locks its thread's question first (#1010), the same lock the visibility change, the
    -- merge and the topic move take. So a reply can't slip in while its thread is made private and
    -- stay public: discussion_threads_guard_reply_target, which runs next (triggers run in name
    -- order), reads the question after this lock and so sees the committed visibility. It is taken
    -- here because this function runs as its owner; the reply guard runs as the user, whose UPDATE
    -- policies wouldn't allow the lock. FOR NO KEY UPDATE, not FOR SHARE: the reply's own insert
    -- then bumps the question's children_count, and a share lock held by two replies at once would
    -- deadlock on that update. The reply takes its question's topic, read after the lock, so a reply
    -- posted while (or after) the thread moved to another topic follows it.
    IF NEW.parent IS NOT NULL AND NEW.root IS NOT NULL THEN
      SELECT q.topic_id INTO v_root_topic_id
      FROM public.discussion_threads q
      WHERE q.id = NEW.root AND q.class_id = NEW.class_id
      FOR NO KEY UPDATE;
      IF FOUND THEN
        NEW.topic_id := v_root_topic_id;
      END IF;
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

  -- UPDATE: the moderator check is for the post's class, looked up only when a change needs it.
  IF NEW.pinned IS DISTINCT FROM OLD.pinned OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
     OR NEW.answer IS DISTINCT FROM OLD.answer THEN
    v_is_moderator := OLD.class_id IN (SELECT public.user_class_ids_with_capability('moderate_discussion'));
  END IF;

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

  IF NEW.answer IS DISTINCT FROM OLD.answer THEN
    IF NOT v_is_moderator AND NOT public.authorizeforprofile_in_class(OLD.author, OLD.class_id) THEN
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
  BEFORE INSERT OR UPDATE OF pinned, answer, topic_id, author, edited_at ON public.discussion_threads
  FOR EACH ROW EXECUTE FUNCTION public.discussion_threads_guard_moderation();

-- ---------------------------------------------------------------------------
-- 6. Columns only the database sets
-- ---------------------------------------------------------------------------

-- RLS can't limit which columns change, so column privileges do. Signed-in users can no longer set
-- a post's id, created_at, updated_at, likes_count, children_count, ordinal or duplicate_* fields,
-- or change root_class_id. The database's own functions and triggers still set them (they run as
-- their owner). The app writes only the columns granted here: a new post or reply (new/page.tsx,
-- discussion_thread.tsx), an edit (body, edited_at), pinning, answers and the RPCs. root_class_id and edited_at are still accepted, but the guard above sets their value.
-- TRUNCATE skips RLS, so it goes too (same as 20261030120000_protect_class_roles.sql).
REVOKE INSERT, UPDATE, TRUNCATE ON public.discussion_threads FROM anon, authenticated;
GRANT INSERT (
  author, subject, body, instructors_only, is_question, answer, class_id, parent, root, draft,
  topic_id, pinned, root_class_id
) ON public.discussion_threads TO authenticated;
-- Not root, parent, class_id or instructors_only: a post moves to another thread only through
-- mark_discussion_thread_duplicate, never to another class, and its visibility changes only through
-- set_discussion_thread_visibility on its thread's root, which locks the root first and changes the
-- root and its replies together (a reply's visibility is set when it is posted). Those functions
-- run as their owner. Not draft either: publishing a reply changed its question's count after
-- locking the reply, the reverse of the order those functions lock in. The app writes none of these.
GRANT UPDATE (
  author, subject, body, is_question, answer, topic_id, pinned, edited_at
) ON public.discussion_threads TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Likes: only on a post you can see, in your class
-- ---------------------------------------------------------------------------

-- Before, "CRUD for own only" checked only that the like was yours, so a like could go on any post
-- (another class's, or a private one) and an existing like could be moved to another post. A like
-- is now added or removed, never changed, and only on a post the user can see in a class they're in
-- (the subquery on discussion_threads runs under its own RLS). A new like is made with the user's
-- private (named) profile, as the app always does, so one person can't like a post twice with their
-- two profiles; and not on the user's own post, which would give them karma.
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
      AND discussion_thread_likes.creator = up.private_profile_id
      AND t.id = discussion_thread_likes.discussion_thread
      AND t.author IS DISTINCT FROM up.private_profile_id
      AND t.author IS DISTINCT FROM up.public_profile_id
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

-- Reply notifications go only to watchers enrolled in the class, and a private reply (even in a
-- public thread) only to staff. New-post notifications skip disabled enrollments, and a private
-- post's unread rows go only to the people who can read it. Re-created from the live body
-- (20260317000000_filter_instructors_only_and_add_message_body.sql); only those filters are new.
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
            -- Not a disabled enrollment (#1010), as for replies below
            AND ur.disabled = false
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
            -- A private reply (#1010) notifies only the watchers who can read it, under the
            -- discussion_threads read rule (section 12): staff, and a private question's author for
            -- the replies in their thread. A reply in a private thread is always private.
            AND (
              NOT COALESCE(NEW.instructors_only, false)
              OR discussion_thread_watchers.user_id IN (SELECT public.discussion_private_post_readers(NEW.id))
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

      -- Unread rows go only to the people who can read this post (#1010, the discussion_threads read
      -- rule in section 12). Everyone in the class can read a public one.

      -- Mark as unread for everyone in the class who can read it, excluding the current user if one exists
      if current_user_id is not null then
        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id)
        select ur.user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id
        from user_roles ur
        where ur.class_id = NEW.class_id and ur.user_id != current_user_id
          and (NOT NEW.instructors_only OR ur.user_id IN (SELECT public.discussion_private_post_readers(NEW.id)));

        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id, read_at)
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id, NEW.created_at as read_at
        from user_roles
        where class_id = NEW.class_id and user_id = current_user_id;
      else
        -- If no current user (seeding context), mark as unread for all users in the class who can read it
        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id)
        select ur.user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id
        from user_roles ur
        where ur.class_id = NEW.class_id
          and (NOT NEW.instructors_only OR ur.user_id IN (SELECT public.discussion_private_post_readers(NEW.id)));
      end if;

   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;

   RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------
-- 9. Discord: a private post isn't queued
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
  v_existing_channel_id text;
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
    AND dt.instructors_only = false; -- Not a private post (#1010)

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
  -- With its channel (#1010): after a topic move, the message is still in the old topic's channel.
  SELECT dm.discord_message_id, dm.discord_channel_id
  INTO v_existing_message_id, v_existing_channel_id
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
          'channel_id', COALESCE(v_existing_channel_id, v_topic.discord_channel_id),
          'message_id', v_existing_message_id,
          'content', v_message_content,
          'embeds', jsonb_build_array(v_embed)
        ),
        'class_id', v_thread.class_id,
        'resource_type', 'discussion_thread',
        'resource_id', p_thread_id,
        'queued_at', now()
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
      'resource_id', p_thread_id,
      -- When it was first queued, kept across the worker's requeues (#1010): the worker compares it
      -- with the thread's updated_at after the send.
      'queued_at', now()
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
--   - a reply's parent and its thread must be posts the user can see, in the same class as the reply,
--     and its root must be the parent's thread;
--   - a reply in a private thread is always private.
-- This function is SECURITY INVOKER on purpose: it runs as the signed-in user, so reading the parent
-- follows discussion_threads' own SELECT policy, with no copy of its rules here. Writes with no
-- signed-in user (service role, seeding) aren't checked, but a reply they write in a private thread
-- is still made private with it.
CREATE OR REPLACE FUNCTION public.discussion_threads_guard_reply_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_signed_in boolean := auth.uid() IS NOT NULL;
  v_parent_class_id bigint;
  v_parent_root bigint;
  v_root_private boolean;
  v_root_class_id bigint;
BEGIN
  IF NEW.parent IS NULL THEN
    IF v_signed_in AND NEW.root IS NOT NULL AND NEW.root IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'A new question can''t be part of another thread'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF v_signed_in THEN
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
  END IF;

  -- The thread itself must be visible too.
  SELECT r.instructors_only, r.class_id INTO v_root_private, v_root_class_id
  FROM public.discussion_threads r
  WHERE r.id = NEW.root;

  IF v_signed_in AND (NOT FOUND OR v_root_class_id IS DISTINCT FROM NEW.class_id) THEN
    RAISE EXCEPTION 'A reply must be to a post you can see in the same class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A reply in a private thread is always private (rule A), whatever the client sent, for every
  -- writer: private with the thread (hidden_with_thread, so its question's author reads it and it is
  -- shown again if the thread is made public), unless it answers a post that is private on its own.
  IF v_root_private THEN
    NEW.instructors_only := true;
    NEW.hidden_with_thread := NOT EXISTS (
      SELECT 1 FROM public.discussion_threads p
      WHERE p.id = NEW.parent AND p.id <> NEW.root AND p.instructors_only AND NOT p.hidden_with_thread
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.discussion_threads_guard_reply_target() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS discussion_threads_guard_reply_target ON public.discussion_threads;
CREATE TRIGGER discussion_threads_guard_reply_target
  BEFORE INSERT ON public.discussion_threads
  FOR EACH ROW EXECUTE FUNCTION public.discussion_threads_guard_reply_target();

-- ---------------------------------------------------------------------------
-- 11. Existing replies in private threads become private
-- ---------------------------------------------------------------------------

-- Rule A for rows written before it: a public reply in a private thread becomes private. Only this
-- direction: a private reply in a public thread is never made public. Every reply in a private thread
-- is marked hidden_with_thread, because until now making a thread public made all its replies public,
-- and that stays true for these threads. Runs with no signed-in user, so the guard doesn't check it.
DO $$
DECLARE
  v_made_private bigint;
  v_marked bigint;
BEGIN
  UPDATE public.discussion_threads r
  SET instructors_only = true,
      hidden_with_thread = true
  FROM public.discussion_threads t
  WHERE t.id = r.root
    AND r.id <> r.root
    AND t.instructors_only
    AND NOT r.instructors_only;
  GET DIAGNOSTICS v_made_private = ROW_COUNT;

  UPDATE public.discussion_threads r
  SET hidden_with_thread = true
  FROM public.discussion_threads t
  WHERE t.id = r.root
    AND r.id <> r.root
    AND t.instructors_only
    AND NOT r.hidden_with_thread;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  RAISE NOTICE 'discussion_by_capability: % public replies in private threads made private; % private replies marked as private with their thread',
    v_made_private, v_marked;
END $$;

-- ---------------------------------------------------------------------------
-- 12. Reading private posts, and realtime
-- ---------------------------------------------------------------------------

-- The read rule for a private post (#1010). Before, anyone with any post in a thread could read every
-- private post in it, so a student who replied in a public thread could read its private replies,
-- and a merge could widen that. Now a private post is readable by staff, its own author (the
-- policy's own branches) and, when the thread's question is private, the question's author, which
-- this function decides. For the question's author that covers only the replies that are private
-- because the thread is (hidden_with_thread): otherwise they could make their public question
-- private for a moment and read the replies that were private on their own.
CREATE OR REPLACE FUNCTION public.authorize_for_private_discussion_thread(p_root bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.discussion_threads q
    WHERE q.id = p_root AND q.instructors_only AND public.authorizeforprofile_in_class(q.author, q.class_id)
  );
$function$;

-- The same rule as a list of readers, for what the database and the service role send on someone's
-- behalf: reply notifications and unread marks (section 8), their cleanup (section 15) and the email
-- digest. A private post's readers are its class's staff, its author and, when it is private with
-- its thread, the thread's question author. The SELECT policy below says the same: change both.
-- Each part is an indexed lookup, and a caller computes the list once per post, not once per user.
CREATE OR REPLACE FUNCTION public.discussion_private_post_readers(p_thread_id bigint)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT up.user_id
  FROM public.discussion_threads t
  JOIN public.user_privileges up
    ON up.class_id = t.class_id AND up.role = ANY (ARRAY['instructor'::public.app_role, 'grader'::public.app_role])
  WHERE t.id = p_thread_id
  UNION
  SELECT up.user_id
  FROM public.discussion_threads t
  JOIN public.user_privileges up ON up.private_profile_id = t.author OR up.public_profile_id = t.author
  WHERE t.id = p_thread_id
  UNION
  SELECT up.user_id
  FROM public.discussion_threads t
  JOIN public.discussion_threads q ON q.id = t.root AND q.instructors_only
  JOIN public.user_privileges up
    ON up.class_id = q.class_id AND (up.private_profile_id = q.author OR up.public_profile_id = q.author)
  WHERE t.id = p_thread_id AND t.hidden_with_thread;
$function$;

-- The ids in p_thread_ids that p_user_id may read: a public post in their class, or a private post
-- they are a reader of. For the email digest, which checks one person's items.
CREATE OR REPLACE FUNCTION public.discussion_threads_readable_by(p_user_id uuid, p_thread_ids bigint[])
 RETURNS SETOF bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT t.id
  FROM public.discussion_threads t
  WHERE t.id = ANY (p_thread_ids)
    AND CASE
      WHEN t.instructors_only THEN p_user_id IN (SELECT public.discussion_private_post_readers(t.id))
      ELSE EXISTS (SELECT 1 FROM public.user_privileges up WHERE up.user_id = p_user_id AND up.class_id = t.class_id)
    END;
$function$;

-- Both take any post or user, so only the database and the service role may call them: for a
-- signed-in user they would tell who wrote or can read someone else's post.
REVOKE ALL ON FUNCTION public.discussion_private_post_readers(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discussion_private_post_readers(bigint) TO service_role;
REVOKE ALL ON FUNCTION public.discussion_threads_readable_by(uuid, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discussion_threads_readable_by(uuid, bigint[]) TO service_role;

-- The SELECT policy, re-created from the live one (20250917002948_optimize-submission-rls.sql) with
-- one change: the question author's branch needs hidden_with_thread (see above). Same name, which
-- Postgres cut to 63 characters when it was first made.
DROP POLICY IF EXISTS "students view all non-private in their class, instructors and g" ON public.discussion_threads;
CREATE POLICY "students view all non-private in their class, instructors and g" ON public.discussion_threads
  FOR SELECT
  USING (
    (
      instructors_only = false
      AND class_id IN (SELECT up.class_id FROM public.user_privileges up WHERE up.user_id = auth.uid())
    )
    OR class_id IN (
      SELECT up.class_id FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.role = ANY (ARRAY['instructor'::public.app_role, 'grader'::public.app_role])
    )
    OR author IN (
      SELECT up.private_profile_id FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
      UNION
      SELECT up.public_profile_id FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.public_profile_id IS NOT NULL
    )
    OR (
      instructors_only = true
      AND hidden_with_thread
      AND public.authorize_for_private_discussion_thread(root)
    )
  );

-- Realtime follows the same rule (#1010). The thread's channel (discussion_thread:<root>) can be
-- joined by anyone in the class when the thread is public, and it carried every row in full, private
-- replies included, which the page then showed. A private row now goes to that channel as its id
-- only; each viewer's TableController re-reads it under the rule above, so only the people who may
-- read it get it, and a row someone can no longer read is dropped from their page. When a question
-- is made private, the students' channel gets its id too, so students' lists drop it. Staff still get
-- every row in full on the staff channel. Re-created from the live body
-- (20251013002255_add_per_thread_broadcast_channels.sql plus later fixes); only the private-row
-- payloads are new.
CREATE OR REPLACE FUNCTION public.broadcast_discussion_threads_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    target_class_id bigint;
    thread_root_id bigint;
    is_root_thread boolean;
    was_root_thread boolean;
    visible_to_students boolean;
    row_full jsonb;
    row_id_only jsonb;
    staff_payload jsonb;
    student_payload jsonb;
    thread_payload jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
        thread_root_id := COALESCE(NEW.root, NEW.id);
        is_root_thread := NEW.root IS NULL OR NEW.root = NEW.id;
        was_root_thread := false;
        visible_to_students := NOT COALESCE(NEW.instructors_only, false);
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
        thread_root_id := COALESCE(NEW.root, OLD.root, NEW.id, OLD.id);
        is_root_thread := (NEW.root IS NULL OR NEW.root = NEW.id);
        was_root_thread := (OLD.root IS NULL OR OLD.root = OLD.id);
        visible_to_students := NOT COALESCE(NEW.instructors_only, false);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
        thread_root_id := COALESCE(OLD.root, OLD.id);
        is_root_thread := OLD.root IS NULL OR OLD.root = OLD.id;
        was_root_thread := is_root_thread;
        visible_to_students := NOT COALESCE(OLD.instructors_only, false);
    END IF;

    row_full := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    row_id_only := jsonb_build_object('id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);

    IF target_class_id IS NOT NULL THEN
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', row_full,
            'class_id', target_class_id,
            'discussion_thread_root_id', thread_root_id,
            'timestamp', NOW()
        );

        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Broadcast to the students channel for the discussion feed when the row is
        -- currently a root OR was previously a root (so a duplicate-merge transition
        -- properly evicts the stale teaser from student caches). Skip for
        -- instructors_only threads to avoid leaking staff-only content to students, except a question
        -- just made private (#1010): its id only, so students' lists re-read it and drop it unless
        -- they may still read it (its author).
        IF (is_root_thread OR was_root_thread)
           AND (visible_to_students OR (TG_OP = 'UPDATE' AND NOT OLD.instructors_only)) THEN
            student_payload := jsonb_build_object(
                'type', 'table_change',
                'operation', TG_OP,
                'table', TG_TABLE_NAME,
                'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
                'data', CASE WHEN visible_to_students THEN row_full ELSE row_id_only END,
                'class_id', target_class_id,
                'timestamp', NOW()
            );

            PERFORM public.safe_broadcast(
                student_payload,
                'broadcast',
                'class:' || target_class_id || ':students',
                true
            );
        END IF;

        -- A private row goes to the thread's channel as its id only (#1010).
        thread_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN visible_to_students THEN row_full ELSE row_id_only END,
            'class_id', target_class_id,
            'discussion_thread_root_id', thread_root_id,
            'timestamp', NOW()
        );

        IF thread_root_id IS NOT NULL THEN
            PERFORM public.safe_broadcast(
                thread_payload,
                'broadcast',
                'discussion_thread:' || thread_root_id,
                true
            );
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.broadcast_discussion_threads_change() IS
  'Discussion thread changes: every row in full to the class staff channel; public questions (and a question just made private, as its id only) to the students channel; each row to its thread''s channel, a private one as its id only so viewers re-read it under the read rule (#1010).';

-- Who can join a thread's channel: the same people as before, except that "has a post in the thread"
-- becomes "wrote the thread's question" (#1010), matching the read rule above. Private rows on the
-- channel are id-only either way.
DROP POLICY IF EXISTS discussion_thread_channel_access ON realtime.messages;
CREATE POLICY discussion_thread_channel_access ON realtime.messages
  FOR SELECT
  USING (
    (topic LIKE 'discussion_thread:%')
    AND (
      EXISTS (
        SELECT 1
        FROM public.discussion_threads dt
        JOIN public.user_roles ur ON dt.class_id = ur.class_id
        WHERE dt.id = (SUBSTRING(realtime.messages.topic FROM 19))::bigint
          AND ur.user_id = auth.uid()
          AND dt.instructors_only = false
      )
      OR EXISTS (
        SELECT 1
        FROM public.discussion_threads dt
        JOIN public.user_roles ur ON dt.class_id = ur.class_id
        WHERE dt.id = (SUBSTRING(realtime.messages.topic FROM 19))::bigint
          AND ur.user_id = auth.uid()
          AND ur.role = ANY (ARRAY['instructor'::public.app_role, 'grader'::public.app_role])
      )
      OR public.authorize_for_private_discussion_thread((SUBSTRING(realtime.messages.topic FROM 19))::bigint)
    )
  );

-- ---------------------------------------------------------------------------
-- 13. Discord: a thread made private, or edited, after it was posted
-- ---------------------------------------------------------------------------

-- Section 9 keeps private posts from being queued, but a thread posted while public kept its Discord
-- message after it was made private, and edits never reached Discord. Now, for a question that has a
-- Discord message:
--   - made private: the message is deleted (a delete_message envelope for the worker). Its tracking
--     row stays until the worker has deleted the message, so a delete that fails, or that an older
--     worker dead-letters during a rollout, is queued again by the hourly stats job, which calls the
--     same queue_discussion_discord_deletes();
--   - made public (again, or for the first time): it is posted, as a new public question is;
--   - its subject, text or shown author changed while public: the message is updated, in the
--     channel the message is in (the topic may have moved since).
-- The worker also re-checks a discussion_thread envelope before sending or updating, so a message
-- queued while the thread was public isn't delivered after it was made private.
-- Queues a delete_message for the Discord message of each private thread that still has one (#1010),
-- or of just p_thread_id. The worker removes the tracking row once Discord has deleted the message,
-- so this finds only messages whose delete hasn't happened yet. Used by the trigger below, the
-- one-time cleanup after it, and the hourly discord-discussion-stats-update job. Returns how many it
-- queued.
CREATE OR REPLACE FUNCTION public.queue_discussion_discord_deletes(
  p_thread_id bigint DEFAULT NULL,
  p_delay_seconds integer DEFAULT 0
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_msg record;
  v_count integer := 0;
BEGIN
  FOR v_msg IN
    SELECT dm.class_id, dm.resource_id, dm.discord_channel_id, dm.discord_message_id
    FROM public.discord_messages dm
    JOIN public.discussion_threads t ON t.id = dm.resource_id AND t.class_id = dm.class_id
    WHERE dm.resource_type::text = 'discussion_thread'
      AND t.instructors_only
      AND (p_thread_id IS NULL OR dm.resource_id = p_thread_id)
  LOOP
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'delete_message',
        'args', jsonb_build_object(
          'channel_id', v_msg.discord_channel_id,
          'message_id', v_msg.discord_message_id
        ),
        'class_id', v_msg.class_id,
        'resource_type', 'discussion_thread',
        'resource_id', v_msg.resource_id
      ),
      sleep_seconds := p_delay_seconds
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.queue_discussion_discord_deletes(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_discussion_discord_deletes(bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.discussion_thread_discord_sync_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.instructors_only THEN
    IF NOT OLD.instructors_only THEN
      PERFORM public.queue_discussion_discord_deletes(NEW.id);
    END IF;
    RETURN NEW;
  END IF;

  -- enqueue_discord_discussion_thread_message sends only for a public, published question, and
  -- updates its message instead when it has one.
  IF OLD.instructors_only THEN
    -- Made public (again, or for the first time): posted, as a new public question is.
    PERFORM public.enqueue_discord_discussion_thread_message(NEW.id, 'created');
  ELSIF EXISTS (
    SELECT 1 FROM public.discord_messages dm
    WHERE dm.class_id = NEW.class_id
      AND dm.resource_type::text = 'discussion_thread'
      AND dm.resource_id = NEW.id
  ) THEN
    -- Its subject, text or shown author changed: its message is updated. A thread never posted
    -- isn't posted by an edit.
    PERFORM public.enqueue_discord_discussion_thread_message(NEW.id, 'updated');
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.discussion_thread_discord_sync_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS discussion_thread_discord_sync ON public.discussion_threads;
CREATE TRIGGER discussion_thread_discord_sync
  AFTER UPDATE OF instructors_only, subject, body, author ON public.discussion_threads
  FOR EACH ROW
  WHEN (NEW.parent IS NULL AND (
    OLD.instructors_only IS DISTINCT FROM NEW.instructors_only
    OR OLD.subject IS DISTINCT FROM NEW.subject
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.author IS DISTINCT FROM NEW.author
  ))
  EXECUTE FUNCTION public.discussion_thread_discord_sync_trigger();

-- Threads made private before this migration kept their Discord message. Delete those now, once,
-- 15 minutes from now: a worker deployed before this PR dead-letters delete_message, and by then
-- the rollout has replaced it. (If one still does, the hourly job queues the delete again.)
SELECT public.queue_discussion_discord_deletes(NULL, 900);

-- ---------------------------------------------------------------------------
-- 14. Older gaps on the same tables
-- ---------------------------------------------------------------------------

-- discussion_thread_watcher_cache copied who watches each thread, and any class member could read
-- it, which could unmask an anonymous poster (the poster watches their own thread). Nothing reads it
-- (the reply notifications read discussion_thread_watchers). Dropped with the trigger that filled it
-- and discussion_threads_notification_optimized, an unused trigger function that read it.
DROP TRIGGER IF EXISTS discussion_thread_watchers_cache_maintenance ON public.discussion_thread_watchers;
DROP FUNCTION IF EXISTS public.update_discussion_thread_watcher_cache();
DROP FUNCTION IF EXISTS public.discussion_threads_notification_optimized();
DROP TABLE IF EXISTS public.discussion_thread_watcher_cache;

-- discussion_thread_ordinal_counters had a policy letting anyone read and write it. Nothing uses it:
-- a post's ordinal comes from discussion_thread_set_ordinal(). Dropped with
-- discussion_thread_set_ordinal_optimized, the unused function that wrote it.
DROP FUNCTION IF EXISTS public.discussion_thread_set_ordinal_optimized();
DROP TABLE IF EXISTS public.discussion_thread_ordinal_counters;

-- Error-pin matches showed the subject of the pinned thread to the student whose submission matched,
-- even when the thread was private (#1010). A private thread's pin is now left out for students;
-- staff, who can read private threads, still get it. Re-created from the live body
-- (20260122100000_global_error_pins.sql); only the two instructors_only filters are new.
CREATE OR REPLACE FUNCTION public.get_error_pin_matches_for_submission(p_submission_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_assignment_id bigint;
    v_class_id bigint;
    v_grader_result_id bigint;
    v_test_id bigint;
    v_pin_record error_pins%ROWTYPE;
    v_rule_record error_pin_rules%ROWTYPE;
    v_rule_matches boolean;
    v_all_rules_match boolean;
    v_match_count int;
    v_result jsonb := '[]'::jsonb;
    v_match jsonb;
    v_matching_test_id bigint;
    v_has_grader_level_rule boolean;
    v_first_test_id bigint;
BEGIN
    -- Authorization check: verify caller is submission owner or authorized instructor/TA
    -- Get assignment and class for this submission
    SELECT assignment_id, class_id INTO v_assignment_id, v_class_id
    FROM submissions
    WHERE id = p_submission_id;
    
    IF v_assignment_id IS NULL OR v_class_id IS NULL THEN
        RETURN v_result;
    END IF;
    
    -- Check if user owns the submission OR is an instructor/grader for the course
    -- Return empty result if unauthorized to prevent leaking which threads matched other students' submissions
    IF NOT (authorize_for_submission(p_submission_id) OR authorizeforclassgrader(v_class_id)) THEN
        RETURN v_result;
    END IF;

    -- Check if matches already exist (cache hit)
    SELECT COUNT(*) INTO v_match_count
    FROM error_pin_submission_matches
    WHERE submission_id = p_submission_id;
    
    IF v_match_count > 0 THEN
        -- Cache hit: return existing matches
        SELECT jsonb_agg(
            jsonb_build_object(
                'error_pin_id', epm.error_pin_id,
                'discussion_thread_id', ep.discussion_thread_id,
                'grader_result_test_id', epm.grader_result_test_id,
                'thread_subject', dt.subject
            )
        ) INTO v_result
        FROM error_pin_submission_matches epm
        JOIN error_pins ep ON ep.id = epm.error_pin_id
        JOIN discussion_threads dt ON dt.id = ep.discussion_thread_id
        WHERE epm.submission_id = p_submission_id
          AND ep.enabled = true
          AND (NOT dt.instructors_only OR authorizeforclassgrader(v_class_id)); -- #1010: a private thread only for staff
        
        RETURN COALESCE(v_result, '[]'::jsonb);
    END IF;

    -- Cache miss: compute matches
    -- Get the grader result for this submission
    SELECT id INTO v_grader_result_id
    FROM grader_results
    WHERE submission_id = p_submission_id
    ORDER BY created_at DESC
    LIMIT 1;
    
    IF v_grader_result_id IS NULL THEN
        RETURN v_result;
    END IF;

    -- Loop through all enabled error pins for this assignment OR class-level pins (assignment_id IS NULL)
    FOR v_pin_record IN
        SELECT * FROM error_pins
        WHERE (assignment_id = v_assignment_id OR (assignment_id IS NULL AND class_id = v_class_id))
          AND enabled = true
    LOOP
        -- Evaluate rules based on logic (AND/OR)
        IF v_pin_record.rule_logic = 'and' THEN
            -- AND logic: all rules must match
            v_all_rules_match := true;
            v_matching_test_id := NULL;
            v_has_grader_level_rule := false;
            v_first_test_id := NULL;
            
            FOR v_rule_record IN
                SELECT * FROM error_pin_rules
                WHERE error_pin_id = v_pin_record.id
                ORDER BY ordinal
            LOOP
                v_rule_matches := false;
                IF v_rule_record.target IN ('lint_output', 'lint_failed', 'grader_score_range', 'grader_output_student', 'grader_output_hidden') THEN
                    v_has_grader_level_rule := true;
                    v_rule_matches := evaluate_error_pin_rule(
                        v_rule_record.target,
                        v_rule_record.match_type,
                        v_rule_record.match_value,
                        v_rule_record.match_value_max,
                        v_rule_record.test_name_filter,
                        p_submission_id,
                        v_grader_result_id
                    );
                ELSE
                    -- For test-level rules, check if any test matches
                    FOR v_test_id IN
                        SELECT id FROM grader_result_tests
                        WHERE grader_result_id = v_grader_result_id
                    LOOP
                        IF evaluate_error_pin_rule(
                            v_rule_record.target,
                            v_rule_record.match_type,
                            v_rule_record.match_value,
                            v_rule_record.match_value_max,
                            v_rule_record.test_name_filter,
                            p_submission_id,
                            v_grader_result_id,
                            v_test_id
                        ) THEN
                            v_rule_matches := true;
                            -- Track the test_id that matched
                            IF v_first_test_id IS NULL THEN
                                v_first_test_id := v_test_id;
                            ELSIF v_first_test_id != v_test_id THEN
                                -- Different test matched, can't use specific test_id
                                v_first_test_id := NULL;
                            END IF;
                            EXIT;
                        END IF;
                    END LOOP;
                END IF;
                IF NOT v_rule_matches THEN
                    v_all_rules_match := false;
                    EXIT;
                END IF;
            END LOOP;
            
            IF v_all_rules_match THEN
                -- If all rules are test-level and they all match the same test, use that test_id
                -- Otherwise, use NULL (submission-level match)
                IF NOT v_has_grader_level_rule AND v_first_test_id IS NOT NULL THEN
                    v_matching_test_id := v_first_test_id;
                END IF;
                
                INSERT INTO error_pin_submission_matches (error_pin_id, submission_id, grader_result_test_id)
                VALUES (v_pin_record.id, p_submission_id, v_matching_test_id)
                ON CONFLICT (error_pin_id, submission_id, grader_result_test_id) DO NOTHING;
            END IF;
        ELSE
            -- OR logic: any rule must match
            FOR v_rule_record IN
                SELECT * FROM error_pin_rules
                WHERE error_pin_id = v_pin_record.id
                ORDER BY ordinal
            LOOP
                IF v_rule_record.target IN ('lint_output', 'lint_failed', 'grader_score_range', 'grader_output_student', 'grader_output_hidden') THEN
                    v_rule_matches := evaluate_error_pin_rule(
                        v_rule_record.target,
                        v_rule_record.match_type,
                        v_rule_record.match_value,
                        v_rule_record.match_value_max,
                        v_rule_record.test_name_filter,
                        p_submission_id,
                        v_grader_result_id
                    );
                    IF v_rule_matches THEN
                        INSERT INTO error_pin_submission_matches (error_pin_id, submission_id, grader_result_test_id)
                        VALUES (v_pin_record.id, p_submission_id, NULL)
                        ON CONFLICT (error_pin_id, submission_id, grader_result_test_id) DO NOTHING;
                        EXIT; -- Found a match, done with this pin
                    END IF;
                ELSE
                    -- Check at test level
                    FOR v_test_id IN
                        SELECT id FROM grader_result_tests
                        WHERE grader_result_id = v_grader_result_id
                    LOOP
                        v_rule_matches := evaluate_error_pin_rule(
                            v_rule_record.target,
                            v_rule_record.match_type,
                            v_rule_record.match_value,
                            v_rule_record.match_value_max,
                            v_rule_record.test_name_filter,
                            p_submission_id,
                            v_grader_result_id,
                            v_test_id
                        );
                        IF v_rule_matches THEN
                            INSERT INTO error_pin_submission_matches (error_pin_id, submission_id, grader_result_test_id)
                            VALUES (v_pin_record.id, p_submission_id, v_test_id)
                            ON CONFLICT (error_pin_id, submission_id, grader_result_test_id) DO NOTHING;
                            EXIT; -- Found a match for this rule
                        END IF;
                    END LOOP;
                    IF v_rule_matches THEN
                        EXIT; -- Found a match, done with this pin
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    -- Return computed matches
    SELECT jsonb_agg(
        jsonb_build_object(
            'error_pin_id', epm.error_pin_id,
            'discussion_thread_id', ep.discussion_thread_id,
            'grader_result_test_id', epm.grader_result_test_id,
            'thread_subject', dt.subject
        )
    ) INTO v_result
    FROM error_pin_submission_matches epm
    JOIN error_pins ep ON ep.id = epm.error_pin_id
    JOIN discussion_threads dt ON dt.id = ep.discussion_thread_id
    WHERE epm.submission_id = p_submission_id
      AND ep.enabled = true
      AND (NOT dt.instructors_only OR authorizeforclassgrader(v_class_id)); -- #1010: a private thread only for staff
    
    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_error_pin_matches_for_submission(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_error_pin_matches_for_submission(bigint) TO authenticated, service_role;

-- An error pin's thread must be in the pin's class (#1010). Staff of two classes could pin one
-- class's thread in the other, and students there then saw its subject. Same rule as before
-- (20260114201651_error_pins.sql), plus the WITH CHECK on the thread.
DROP POLICY IF EXISTS "Instructors and graders CRUD" ON public.error_pins;
CREATE POLICY "Instructors and graders CRUD" ON public.error_pins
  USING (public.authorizeforclassgrader(class_id))
  WITH CHECK (
    public.authorizeforclassgrader(class_id)
    AND EXISTS (
      SELECT 1 FROM public.discussion_threads dt
      WHERE dt.id = error_pins.discussion_thread_id
        AND dt.class_id = error_pins.class_id
    )
  );

-- A discussion topic stays in its class (#1010). The update rule checks the instructor's access to
-- the old and the new class, so an instructor of two classes could move a topic, with its threads'
-- topic links, into the other class.
CREATE OR REPLACE FUNCTION public.discussion_topics_keep_class()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.class_id IS DISTINCT FROM OLD.class_id THEN
    RAISE EXCEPTION 'A discussion topic can''t move to another class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.discussion_topics_keep_class() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS discussion_topics_keep_class ON public.discussion_topics;
CREATE TRIGGER discussion_topics_keep_class
  BEFORE UPDATE OF class_id ON public.discussion_topics
  FOR EACH ROW EXECUTE FUNCTION public.discussion_topics_keep_class();

-- ---------------------------------------------------------------------------
-- 15. Reply counts and unread marks only count posts the reader can read
-- ---------------------------------------------------------------------------

-- children_count counted every reply, private ones included, and every reader of the question got
-- it (select *, realtime): a student could tell a thread had private replies, and its "N new" never
-- cleared for the ones they can't read. It now counts the replies every reader of the question can
-- read: the public ones, or in a private thread the ones private with it, which its question's
-- author reads. So it tells nobody more than they can read; staff, who read the private replies
-- too, see them on the thread page. One recount per statement replaces the old +1/-1 triggers:
-- a reply changes what it counts as in several ways (published, hidden or shown with its thread,
-- moved by a merge). Its own UPDATE of the questions fires it again and finds no reply changed.
-- Only the visibility change and the merge change a reply's visibility or thread, and both lock the
-- question first, as a new reply does (section 5), so this UPDATE never waits on a question another
-- transaction locked first.
CREATE OR REPLACE FUNCTION public.recount_discussion_thread_children(p_roots bigint[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  UPDATE public.discussion_threads q
  SET children_count = c.n
  FROM (
    SELECT r.id, (
      SELECT count(*)
      FROM public.discussion_threads ch
      WHERE ch.root = r.id
        AND ch.id <> r.id
        AND NOT ch.draft
        AND (NOT ch.instructors_only OR ch.hidden_with_thread)
    ) AS n
    FROM unnest(p_roots) AS r(id)
  ) c
  WHERE q.id = c.id
    AND q.children_count IS DISTINCT FROM c.n;
$function$;

CREATE OR REPLACE FUNCTION public.discussion_threads_recount_children()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_roots bigint[];
BEGIN
  -- An inserted or deleted reply changes a count only if it is one that counts.
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT n.root) INTO v_roots FROM new_table n
    WHERE n.root <> n.id AND NOT n.draft AND (NOT n.instructors_only OR n.hidden_with_thread);
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT o.root) INTO v_roots FROM old_table o
    WHERE o.root <> o.id AND NOT o.draft AND (NOT o.instructors_only OR o.hidden_with_thread);
  ELSE
    SELECT array_agg(DISTINCT x.r) INTO v_roots
    FROM old_table o
    JOIN new_table n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.root), (n.root)) AS x(r)
    WHERE (o.root, o.draft, o.instructors_only, o.hidden_with_thread)
          IS DISTINCT FROM (n.root, n.draft, n.instructors_only, n.hidden_with_thread)
      AND x.r IS NOT NULL
      AND x.r <> o.id;
  END IF;

  -- Also what ends the recursion: a statement trigger fires even for an UPDATE of no rows.
  IF v_roots IS NOT NULL THEN
    PERFORM public.recount_discussion_thread_children(v_roots);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.recount_discussion_thread_children(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.discussion_threads_recount_children() FROM PUBLIC, anon, authenticated;

-- Same trigger names, now on the recount. The old functions go: update_children_count_statement
-- (the +1/-1 it replaces), update_children_count (no trigger used it) and
-- recalculate_discussion_thread_children_counts (unused, and any signed-in user could run it).
DROP TRIGGER IF EXISTS discussion_threads_children_insert ON public.discussion_threads;
CREATE TRIGGER discussion_threads_children_insert
  AFTER INSERT ON public.discussion_threads
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.discussion_threads_recount_children();
DROP TRIGGER IF EXISTS discussion_threads_children_update ON public.discussion_threads;
CREATE TRIGGER discussion_threads_children_update
  AFTER UPDATE ON public.discussion_threads
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.discussion_threads_recount_children();
DROP TRIGGER IF EXISTS discussion_threads_children_delete ON public.discussion_threads;
CREATE TRIGGER discussion_threads_children_delete
  AFTER DELETE ON public.discussion_threads
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT EXECUTE FUNCTION public.discussion_threads_recount_children();
DROP FUNCTION IF EXISTS public.update_children_count_statement();
DROP FUNCTION IF EXISTS public.update_children_count();
DROP FUNCTION IF EXISTS public.recalculate_discussion_thread_children_counts(bigint);

-- Existing threads, once: the ones whose count included private replies. Replies keep no count
-- (only a question's replies are counted), but older ones still carry one that counted private
-- replies, readable like any column.
SELECT public.recount_discussion_thread_children(array_agg(DISTINCT ch.root))
FROM public.discussion_threads ch
WHERE ch.instructors_only AND ch.root <> ch.id;
UPDATE public.discussion_threads SET children_count = 0 WHERE root IS NOT NULL AND root <> id AND children_count <> 0;

-- Unread marks follow the read rule too. They are made only for the people who can read a post
-- (section 8), but a thread made private leaves marks for people who can't read it now, and marks
-- made before this migration exist for private posts their owners can't read. Those go, so "N new"
-- counts only posts the reader can read. The app counts a thread's unread marks rather than
-- subtracting its read ones from the reply count.
CREATE OR REPLACE FUNCTION public.prune_discussion_thread_read_status(p_root bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  DELETE FROM public.discussion_thread_read_status rs
  USING (
    SELECT t.id, ARRAY(SELECT public.discussion_private_post_readers(t.id)) AS readers
    FROM public.discussion_threads t
    WHERE t.root = p_root AND t.instructors_only
  ) p
  WHERE rs.discussion_thread_root_id = p_root
    AND rs.discussion_thread_id = p.id
    AND rs.user_id <> ALL (p.readers);
$function$;

REVOKE ALL ON FUNCTION public.prune_discussion_thread_read_status(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_discussion_thread_read_status(bigint) TO service_role;

-- The marks made before this migration, once: every thread with a private post.
SELECT public.prune_discussion_thread_read_status(x.root)
FROM (SELECT DISTINCT t.root FROM public.discussion_threads t WHERE t.instructors_only AND t.root IS NOT NULL) x;

-- The email digest keeps which reply each item is about (#1010), so it can apply the read rule to
-- that reply instead of to its whole thread.
ALTER TABLE public.discussion_digest_items ADD COLUMN IF NOT EXISTS comment_id bigint;

COMMENT ON COLUMN public.discussion_digest_items.comment_id IS
  'The post the item is about (the notification''s new_comment_id). NULL for items stored before #1010; the digest then checks the thread.';
