-- Two independent karma defects, both audited 2026-08.
--
-- PART A (public.update_discussion_karma): discussion karma was credited to the
--   author's PRIVATE profile but rendered from whichever profile authored the
--   post, so karma earned on pseudonymous posts was invisible. Making the counter
--   per-identity also means it must follow a post when staff move it between a
--   student's two identities, so this adds a transfer trigger on
--   discussion_threads.author (see the note above that trigger).
-- PART B (public.broadcast_help_request_staff_data_change): the office-hours
--   karma-note branch read NEW/OLD.help_request_id, a column that does not
--   exist on public.student_karma_notes, so every insert/update/delete on that
--   table aborted with `record "new" has no field "help_request_id"`.
--
-- The two are unrelated subsystems that happen to share the word "karma":
-- profiles.discussion_karma (likes on discussion posts) vs.
-- student_karma_notes.karma_score (staff-authored office-hours notes).

-- ---------------------------------------------------------------------------
-- PART B: student_karma_notes is class-scoped, not help-request-scoped.
-- ---------------------------------------------------------------------------
--
-- Regression history: the karma branch was introduced correctly in
-- 20250813234857_office-hours-and-notifications.sql (no help_request_id, with a
-- comment saying karma "isn't directly tied to a help request"), then rewritten
-- in 20250910001703_help-request-scope-messages.sql:297,302,307 as a copy of the
-- help_request_moderation branch -- which does have that column. plpgsql resolves
-- NEW.<field> at execution time, so the bad reference only errored when the
-- branch ran; because it ran on every row operation on student_karma_notes, the
-- office-hours karma feature was 100% non-functional from 2025-09-10 onward.
--
-- Do not reintroduce help_request_id here: check `\d student_karma_notes` first.
-- The payload key is retained (as NULL) so subscribers see a stable shape.
--
-- Also pins search_path: the prior definition was SECURITY DEFINER with an
-- unpinned search_path.

CREATE OR REPLACE FUNCTION public.broadcast_help_request_staff_data_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    help_request_id BIGINT;
    class_id BIGINT;
    student_profile_id UUID;
    row_id BIGINT;
    staff_payload JSONB;
BEGIN
    -- Get relevant IDs based on table
    IF TG_TABLE_NAME = 'help_request_moderation' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.help_request_id;
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := COALESCE(NEW.help_request_id, OLD.help_request_id);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            student_profile_id := COALESCE(NEW.student_profile_id, OLD.student_profile_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.help_request_id;
            class_id := OLD.class_id;
            student_profile_id := OLD.student_profile_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'student_karma_notes' THEN
        -- student_karma_notes has NO help_request_id column: karma notes are
        -- attached to a student within a class, not to one help request.
        help_request_id := NULL;
        IF TG_OP = 'INSERT' THEN
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            student_profile_id := COALESCE(NEW.student_profile_id, OLD.student_profile_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id := OLD.class_id;
            student_profile_id := OLD.student_profile_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_request_templates' THEN
        IF TG_OP = 'INSERT' THEN
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    END IF;

    -- Build payload
    staff_payload := jsonb_build_object(
        'type', 'staff_data_change',
        'operation', TG_OP,
        'table', TG_TABLE_NAME,
        'row_id', row_id,
        'class_id', class_id,
        'student_profile_id', student_profile_id,
        'help_request_id', help_request_id,
        'data', CASE
            WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
            ELSE to_jsonb(NEW)
        END,
        'timestamp', NOW()
    );

    -- Always broadcast to office-hours staff channel
    IF class_id IS NOT NULL THEN
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'help_queues:' || class_id || ':staff',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.broadcast_help_request_staff_data_change() IS
'Broadcasts help_request_moderation, student_karma_notes and help_request_templates changes to the class staff channel. student_karma_notes is class-scoped and has no help_request_id column: reading NEW.help_request_id there aborts the write.';

-- ---------------------------------------------------------------------------
-- PART A: credit discussion karma to the profile that authored the post.
-- ---------------------------------------------------------------------------
--
-- WHY THIS CREDITS THE RAW dt.author AND NOT user_roles.private_profile_id
-- (please read before "fixing" this back):
--
-- Every student has two profiles per class: a private one carrying their real
-- name, and a public pseudonym. A post's `author` is the private profile for a
-- named post and the public profile for an anonymous one
-- (app/course/[course_id]/discussion/new/page.tsx). Discussion bylines render
-- the karma of `thread.author` verbatim, via useUserProfile(thread.author)
-- (hooks/useUserProfiles.tsx). The previous definition normalized the credit to
-- the private profile, so a pseudonymous byline always read 0.
--
-- The tempting alternative -- keep the normalized credit and make the byline
-- read the private profile's karma -- is the one option that actually leaks. That
-- number aggregates the person's NAMED posts too, so a classmate can read a
-- distinctive total off a named byline and match it on a pseudonymous one,
-- linking pseudonym to real identity.
--
-- Per-identity counters carry no such signal: the public profile's karma is a
-- function only of likes on pseudonymously-authored threads, which classmates can
-- already compute themselves (the discussion_threads SELECT policy exposes
-- `author` and `likes_count` class-wide). It reveals nothing new. The normalized
-- column was in fact the weaker position: because profiles' "View in same class"
-- SELECT policy lets any classmate read every profile row, a classmate could
-- subtract the publicly-visible named-post likes from a private profile's
-- normalized total to recover that person's pseudonymous like count, then match it
-- against each pseudonym. Splitting the counters closes that channel.
--
-- Whole-student totals are still needed for staff reporting, so they are summed
-- in get_discussion_engagement below, which is staff-only three times over: the
-- /manage/ layout redirects non-staff (app/course/[course_id]/manage/layout.tsx),
-- the page re-checks the role, and the RPC itself raises insufficient_privilege.
-- There is no student-facing karma leaderboard. If one is ever added, it must
-- publish per-identity karma, never the aggregated total.

CREATE OR REPLACE FUNCTION public.update_discussion_karma()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    thread_author_id uuid;
BEGIN
    -- Credit the profile that authored the post, with no public->private
    -- normalization: karma is per-identity. See the migration header for why.
    --
    -- FOR UPDATE serializes this read against a concurrent author change. Without
    -- it, a like committing while an anonymity toggle is in flight could read the
    -- pre-toggle author and credit the old identity, while that toggle's transfer
    -- (below) counts likes without seeing this uncommitted one -- stranding the
    -- credit. In practice the BEFORE trigger update_thread_likes already write-locks
    -- this row to bump likes_count, so the hazard is currently unreachable and this
    -- lock is free (the transaction already holds it). It is taken explicitly so the
    -- karma invariant does not silently depend on an unrelated denormalized counter.
    --
    -- Lock order is thread row -> profiles row here and in
    -- transfer_discussion_karma_on_author_change; keep it that way.
    IF TG_OP = 'INSERT' THEN
        SELECT dt.author INTO thread_author_id
        FROM public.discussion_threads dt
        WHERE dt.id = NEW.discussion_thread
        FOR UPDATE;

        IF thread_author_id IS NOT NULL THEN
            UPDATE public.profiles
            SET discussion_karma = discussion_karma + 1
            WHERE id = thread_author_id;
        END IF;

        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT dt.author INTO thread_author_id
        FROM public.discussion_threads dt
        WHERE dt.id = OLD.discussion_thread
        FOR UPDATE;

        IF thread_author_id IS NOT NULL THEN
            UPDATE public.profiles
            SET discussion_karma = GREATEST(0, discussion_karma - 1)
            WHERE id = thread_author_id;
        END IF;

        RETURN OLD;
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.update_discussion_karma() IS
'Updates discussion_karma on profiles when discussion_thread_likes are added or removed. Credits the profile that authored the post (public profile for anonymous posts, private otherwise) so the byline badge matches the credited row; whole-student totals are aggregated in get_discussion_engagement.';

COMMENT ON COLUMN public.profiles.discussion_karma IS
'Likes received on discussion posts authored BY THIS PROFILE. Per-identity by design: a student''s pseudonym and real profile each carry their own count, and they must not be summed on any student-visible surface. get_discussion_engagement sums them for staff.';

-- Per-identity karma only stays correct if the counter follows the post when its
-- author changes. Staff can move a thread between a student's two identities via
-- toggle_discussion_thread_author_anonymity (20260115201143), which rewrites
-- discussion_threads.author on the root and its descendants. Likes already cast
-- would otherwise stay credited to the old identity while the byline reads the new
-- one, and a later unlike would decrement the NEW identity -- bottoming out at the
-- GREATEST(0, ...) floor -- and leave the old counter permanently inflated.
--
-- The previous normalized implementation was immune to this: it credited the
-- private profile whichever identity the thread pointed at, so a toggle changed
-- nothing. This transfer is the cost of the per-identity split, and it is paid here.
--
-- Implemented as a trigger on discussion_threads rather than inside that RPC:
-- the invariant is "profiles.discussion_karma equals the number of likes on threads
-- this profile authored", and a trigger keeps it true for ANY writer of `author`.
-- The RPC is currently the only one, but it is not privileged in enforcing this,
-- and a data migration or admin fixup would silently reintroduce the drift.
--
-- `UPDATE OF author` fires on the statement's SET column list even when the value
-- is unchanged, so the WHEN clause -- not the column list -- is what makes this exact.
CREATE OR REPLACE FUNCTION public.transfer_discussion_karma_on_author_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_likes bigint;
BEGIN
    SELECT COUNT(*) INTO v_likes
    FROM public.discussion_thread_likes dtl
    WHERE dtl.discussion_thread = NEW.id;

    -- Most threads have no likes, and the anonymity toggle rewrites every
    -- descendant of a root, so skip the write entirely in the common case.
    IF v_likes = 0 THEN
        RETURN NEW;
    END IF;

    -- Debit the old identity and credit the new one, ALWAYS in ascending profile id
    -- order. This previously ran as a single UPDATE ... FROM (VALUES (OLD), (NEW)),
    -- which locks rows in whatever order the plan produces: on a small table the
    -- planner seq-scans profiles (a consistent order, so it looks fine locally), but
    -- at production size it switches to a nested loop over the VALUES list and locks
    -- in OLD-then-NEW order. Two concurrent transfers moving posts in opposite
    -- directions between the same pair of profiles then grab the two rows in
    -- opposite orders and deadlock -- reproduced at 5 deadlocks per 1200 transfers
    -- with enable_seqscan=off. Ordering by id removes the cycle by construction, and
    -- plpgsql statement order guarantees it regardless of the plan.
    -- GREATEST(0, ...) matches the unlike path's floor.
    IF OLD.author < NEW.author THEN
        UPDATE public.profiles SET discussion_karma = GREATEST(0, discussion_karma - v_likes)
        WHERE id = OLD.author;
        UPDATE public.profiles SET discussion_karma = discussion_karma + v_likes
        WHERE id = NEW.author;
    ELSE
        UPDATE public.profiles SET discussion_karma = discussion_karma + v_likes
        WHERE id = NEW.author;
        UPDATE public.profiles SET discussion_karma = GREATEST(0, discussion_karma - v_likes)
        WHERE id = OLD.author;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.transfer_discussion_karma_on_author_change() IS
'Moves a thread''s accumulated likes between profiles when discussion_threads.author changes (e.g. staff toggling anonymity), keeping per-identity discussion_karma consistent with the profile the byline renders.';

DROP TRIGGER IF EXISTS transfer_discussion_karma_on_author_change_trigger ON public.discussion_threads;
CREATE TRIGGER transfer_discussion_karma_on_author_change_trigger
    AFTER UPDATE OF author
    ON public.discussion_threads
    FOR EACH ROW
    WHEN (OLD.author IS DISTINCT FROM NEW.author)
    EXECUTE FUNCTION public.transfer_discussion_karma_on_author_change();

COMMENT ON TRIGGER transfer_discussion_karma_on_author_change_trigger ON public.discussion_threads IS
'Keeps per-identity discussion_karma correct when a post is moved between a student''s public and private profiles.';

-- Recompute karma under the new per-identity semantics. Runs after the trigger
-- replacement above so the final state is consistent with the installed trigger.
--
-- It recomputes from each thread's CURRENT author, so threads that staff already
-- moved between identities land on the profile the byline reads today; no separate
-- repair pass is needed for historical toggles.
--
-- Scoped to rows that actually change rather than a blanket UPDATE of every
-- profile (which is what 20260118214344 did). At prod scale `profiles` holds one
-- row per enrollment per parity across all classes ever taught, so an
-- unconditional UPDATE would create a new row version for every one of them plus
-- index churn, and hold row locks class-wide for the duration. The drift set here
-- is small: only private profiles that had earned pseudonymous likes, and the
-- public profiles those likes move to. The scan of `profiles` is read-only.
WITH actual AS (
    SELECT dt.author AS profile_id, COUNT(*)::bigint AS karma
    FROM public.discussion_thread_likes dtl
    JOIN public.discussion_threads dt ON dt.id = dtl.discussion_thread
    GROUP BY dt.author
),
drift AS (
    SELECT p.id, COALESCE(a.karma, 0) AS karma
    FROM public.profiles p
    LEFT JOIN actual a ON a.profile_id = p.id
    WHERE p.discussion_karma <> COALESCE(a.karma, 0)
)
UPDATE public.profiles p
SET discussion_karma = d.karma
FROM drift d
WHERE p.id = d.id;

-- Staff engagement report: sum both identities so instructors still see a
-- whole-student total. Safe here and only here -- see the header note on why the
-- aggregated total must not reach a student-visible surface.
CREATE OR REPLACE FUNCTION public.get_discussion_engagement(p_class_id bigint)
RETURNS TABLE (
  profile_id uuid,
  name text,
  discussion_karma bigint,
  total_posts bigint,
  total_replies bigint,
  likes_received bigint,
  likes_given bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_is_authorized boolean;
BEGIN
  -- Authorization guard: verify caller is instructor or grader for this class
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.user_id = auth.uid()
      AND ur.role IN ('instructor', 'grader')
      AND ur.disabled = false
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Access denied: Instructor or grader role required for this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH profile_mapping AS (
    -- Map public profile IDs to private profile IDs
    SELECT ur.public_profile_id, ur.private_profile_id
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id AND ur.disabled = false
  ),
  karma_totals AS (
    -- Whole-student karma: profiles.discussion_karma is per-identity, so a
    -- student's named-post karma and pseudonymous karma live on separate rows.
    SELECT ur.private_profile_id AS author_id,
           COALESCE(priv.discussion_karma, 0) + COALESCE(pub.discussion_karma, 0) AS karma
    FROM public.user_roles ur
    JOIN public.profiles priv ON priv.id = ur.private_profile_id
    LEFT JOIN public.profiles pub ON pub.id = ur.public_profile_id
    WHERE ur.class_id = p_class_id AND ur.disabled = false
  ),
  thread_counts AS (
    -- Count posts and replies per normalized author
    SELECT
      COALESCE(pm.private_profile_id, dt.author) AS author_id,
      COUNT(*) FILTER (WHERE dt.parent IS NULL) AS posts,
      COUNT(*) FILTER (WHERE dt.parent IS NOT NULL) AS replies
    FROM public.discussion_threads dt
    LEFT JOIN profile_mapping pm ON pm.public_profile_id = dt.author
    WHERE dt.class_id = p_class_id AND dt.draft = false
    GROUP BY COALESCE(pm.private_profile_id, dt.author)
  ),
  likes_given_counts AS (
    -- Count likes given per normalized creator
    SELECT
      COALESCE(pm.private_profile_id, dtl.creator) AS giver_id,
      COUNT(*) AS given_count
    FROM public.discussion_thread_likes dtl
    INNER JOIN public.discussion_threads dt ON dt.id = dtl.discussion_thread
    LEFT JOIN profile_mapping pm ON pm.public_profile_id = dtl.creator
    WHERE dt.class_id = p_class_id
    GROUP BY COALESCE(pm.private_profile_id, dtl.creator)
  )
  SELECT
    p.id AS profile_id,
    p.name,
    COALESCE(kt.karma, p.discussion_karma) AS discussion_karma,
    COALESCE(tc.posts, 0)::bigint AS total_posts,
    COALESCE(tc.replies, 0)::bigint AS total_replies,
    COALESCE(kt.karma, p.discussion_karma) AS likes_received,
    COALESCE(lg.given_count, 0)::bigint AS likes_given
  FROM public.profiles p
  LEFT JOIN karma_totals kt ON kt.author_id = p.id
  LEFT JOIN thread_counts tc ON tc.author_id = p.id
  LEFT JOIN likes_given_counts lg ON lg.giver_id = p.id
  WHERE p.class_id = p_class_id AND p.is_private_profile = true
  ORDER BY COALESCE(kt.karma, p.discussion_karma) DESC;
END;
$$;

COMMENT ON FUNCTION public.get_discussion_engagement(bigint) IS
'Returns discussion engagement metrics (posts, replies, likes) for all students in a class, summing each student''s per-identity discussion_karma across their private and public profiles. Instructor/grader only.';
