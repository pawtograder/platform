-- Fixes for the findings of the 2026-08 audit, plus defects found while verifying them.
--
-- Flattened from five per-area migrations into one file. Sections run in their original
-- order and are independent of one another; each keeps its own rationale, which is
-- load-bearing -- several of these encode a decision (why karma credits the raw author,
-- why the audit policy lives on the partitioned parent only, why a NULL lab end_time
-- defaults to 23:59:59) that reads as a bug if you meet the code without it.
--
-- Sections:
--   1. Karma: credit the authoring profile, transfer on author change, fix the notes broadcast
--   2. Help requests: privacy can only escalate, and follow-up links are persisted
--   3. Audit log RLS, leaderboard anon scoping, and client write revokes
--   4. Due dates: include exceptions, and default a NULL lab end_time
--   5. Discussion anonymity toggle: correct the uuid/text declarations


----------------------------------------------------------------------------------------------------
-- SECTION 1: Karma: credit the authoring profile, transfer on author change, fix the notes broadcast
-- (was 20260825140000_audit_findings_2026_08.sql)
----------------------------------------------------------------------------------------------------

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

----------------------------------------------------------------------------------------------------
-- SECTION 2: Help requests: privacy can only escalate, and follow-up links are persisted
-- (was 20260825140000_audit_findings_2026_08.sql)
----------------------------------------------------------------------------------------------------

-- Office-hours audit follow-ups: help-request privacy boundary + followup_to plumbing.
--
-- Two changes, both in the help-request area:
--
-- 1. forbid_help_request_privacy_downgrade
--    help_requests.is_private was writable true -> false by any participant. The
--    "Students can update their own help requests" policy puts no column restriction on
--    the row, so the client could (and did) publish a private request as a side effect of
--    an unrelated edit: saving the "Referenced Code" panel recomputed
--    `is_private = (has file refs OR has submission ref)`, so removing the last code
--    reference flipped the request public. That exposed the whole thread, because RLS on
--    help_request_messages goes through can_access_help_request(), which branches on this
--    flag, and because broadcast_help_requests_to_class() re-broadcasts the row to
--    class:<id>:students with a privacy-aware payload.
--
--    The client no longer downgrades (help-request-chat.tsx now escalates only), but the
--    client is not the boundary. This trigger is: only course staff may take a private
--    help request public. If we ever want to offer students an explicit "make this
--    public" control, it needs its own SECURITY DEFINER RPC that re-checks the caller and
--    what is attached to the request -- not a direct column write from a form save.
--
--    The check authorizes against OLD.class_id and the trigger also forbids changing
--    class_id at all. Authorizing against NEW.class_id was bypassable: a participant who
--    is staff in a different class could set class_id to that class and is_private=false
--    in one PATCH -- the UPDATE policy admits them via user_is_in_help_request(id) for
--    both rows -- and the request was published into the substituted class. Reproduced
--    end to end through PostgREST (HTTP 200, row left at class_id=<other>,
--    is_private=false) before this was tightened.
--
-- 2. create_help_request_with_participants gains p_followup_to
--    The new-request form collects "Follow-Up to Previous Request" (and pre-fills it from
--    ?followup_to=<id>, which the queue list's Follow-Up button links to), but the RPC had
--    no such parameter and its INSERT never listed the column, so every follow-up link was
--    dropped and help_requests.followup_to was always null -- including in the staff CLI's
--    `help-requests list` output, which selects and prints it.
--
--    Adding a defaulted parameter with CREATE OR REPLACE would register a second overload
--    and make the existing 8-argument PostgREST calls ambiguous ("function is not
--    unique"), so the old signature is dropped first. Ordering is safe in both directions
--    during a rolling deploy: an old client sends the same 8 named arguments and resolves
--    against the new all-defaults signature.
--
--    followup_to also had no foreign key, so this migration adds one.

-- 1. Privacy downgrades are staff-only ------------------------------------------------

CREATE OR REPLACE FUNCTION public.forbid_help_request_privacy_downgrade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    -- Attached to `BEFORE UPDATE OF is_private, class_id`, which fires on the statement's
    -- column list rather than on an actual value change, so the OLD/NEW comparisons here
    -- are what do the work: a no-op write of the same value is allowed through.

    -- A help request never changes class. Nothing in the product moves one -- the class
    -- is derived from the queue at creation and no code path writes this column -- and
    -- allowing it defeats the privacy check below. The UPDATE policy admits a participant
    -- through user_is_in_help_request(id), which is class-independent and passes for both
    -- the old and the new row, so a participant who happens to be staff in some OTHER
    -- class could re-home the request into that class and authorize their own downgrade:
    -- in a single statement if we authorized against NEW, or in two statements (move,
    -- then downgrade) even if we authorize against OLD. Blocking the move is what closes
    -- both. It is also the only thing keeping the row consistent with its help_queue,
    -- which belongs to the original class.
    IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
        RAISE EXCEPTION 'help request % cannot be moved between classes', OLD.id
            USING ERRCODE = '42501';
    END IF;

    -- Authorize against OLD.class_id. NEW.class_id is caller-controlled in the same
    -- statement, so authorizing against it would let the caller pick the class that
    -- grants them staff privileges.
    IF OLD.is_private = true AND NEW.is_private = false
       AND NOT public.authorizeforclassgrader(OLD.class_id) THEN
        RAISE EXCEPTION 'only course staff may make a private help request public'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.forbid_help_request_privacy_downgrade() OWNER TO postgres;

COMMENT ON FUNCTION public.forbid_help_request_privacy_downgrade() IS
'Guards the help-request privacy boundary. Rejects true -> false transitions of help_requests.is_private unless the caller is an instructor or grader in the request''s OWN class (OLD.class_id), and rejects any change to class_id. RLS lets any participant update their own help request row with no column restriction, and a client-side edit path used to publish private requests as a side effect of removing their last code reference, exposing the whole message thread (help_request_messages RLS reads this flag via can_access_help_request). Authorizing against NEW.class_id would be caller-controlled: a participant who is staff in another class could move the request there and approve their own downgrade.';

DROP TRIGGER IF EXISTS forbid_help_request_privacy_downgrade_tr ON public.help_requests;
CREATE TRIGGER forbid_help_request_privacy_downgrade_tr
    BEFORE UPDATE OF is_private, class_id ON public.help_requests
    FOR EACH ROW EXECUTE FUNCTION public.forbid_help_request_privacy_downgrade();

-- 2. followup_to: foreign key ----------------------------------------------------------

-- Self-referencing, and nulled rather than cascaded: a follow-up must outlive the request
-- it points back at. Validation is a trivial scan today because nothing has ever written
-- this column (verified 0 non-null values, 0 dangling ids before adding the constraint).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.help_requests'::regclass
           AND conname = 'help_requests_followup_to_fkey'
    ) THEN
        ALTER TABLE public.help_requests
            ADD CONSTRAINT help_requests_followup_to_fkey
            FOREIGN KEY (followup_to) REFERENCES public.help_requests(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- 3. create_help_request_with_participants: accept and persist followup_to -------------

DROP FUNCTION IF EXISTS public.create_help_request_with_participants(
    bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb);

CREATE OR REPLACE FUNCTION public.create_help_request_with_participants(
    p_help_queue_id bigint,
    p_request text,
    p_is_private boolean DEFAULT false,
    p_location_type public.location_type DEFAULT 'remote',
    p_student_profile_ids uuid[] DEFAULT ARRAY[]::uuid[],
    p_template_id bigint DEFAULT NULL,
    p_referenced_submission_id bigint DEFAULT NULL,
    p_file_references jsonb DEFAULT '[]'::jsonb,
    p_followup_to bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_uid uuid := auth.uid();
    v_class_id bigint;
    v_caller_private_profile uuid;
    v_help_queue_available boolean;
    v_help_queue_is_demo boolean;
    v_help_queue_active_staff_count int;
    v_help_request_id bigint;
    v_invalid_count int;
    v_existing_solo_count int;
    v_student uuid;
    v_file jsonb;
    v_help_queue_name text;
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated'
            USING ERRCODE = '28000';
    END IF;

    IF p_request IS NULL OR length(trim(p_request)) = 0 THEN
        RAISE EXCEPTION 'request body is required'
            USING ERRCODE = '22023';
    END IF;

    -- 1. Resolve queue → class. Use a single fetch to also grab the
    --    "is this queue accepting requests" + name signals.
    SELECT class_id, available, is_demo, name
      INTO v_class_id, v_help_queue_available, v_help_queue_is_demo, v_help_queue_name
      FROM public.help_queues
     WHERE id = p_help_queue_id;
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'help_queue % does not exist', p_help_queue_id
            USING ERRCODE = '22023';
    END IF;
    IF NOT (v_help_queue_is_demo OR v_help_queue_available) THEN
        RAISE EXCEPTION 'queue is not accepting new requests'
            USING ERRCODE = '22023';
    END IF;

    -- 2. Caller must be an active member of the class. Resolve the
    --    private_profile_id we'll write into help_requests.created_by /
    --    help_request_messages.author from the same row.
    SELECT private_profile_id
      INTO v_caller_private_profile
      FROM public.user_roles
     WHERE user_id = v_caller_uid
       AND class_id = v_class_id
       AND disabled = false
     LIMIT 1;
    IF v_caller_private_profile IS NULL THEN
        RAISE EXCEPTION 'caller is not enrolled in class %', v_class_id
            USING ERRCODE = '42501';
    END IF;

    -- 3. Active-staff gate for non-demo queues. Same predicate as the
    --    legacy client-side `queueIdsWithActiveStaff` check.
    IF NOT v_help_queue_is_demo THEN
        SELECT count(*)
          INTO v_help_queue_active_staff_count
          FROM public.help_queue_assignments
         WHERE help_queue_id = p_help_queue_id
           AND is_active = true
           AND ended_at IS NULL;
        IF v_help_queue_active_staff_count = 0 THEN
            RAISE EXCEPTION 'queue % is not currently staffed', v_help_queue_name
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 4. Caller must be in their own participants list. We allow the
    --    caller to send an empty / null participants list and default it
    --    to "just me", which matches the form's auto-add-self behavior.
    IF p_student_profile_ids IS NULL OR array_length(p_student_profile_ids, 1) IS NULL THEN
        p_student_profile_ids := ARRAY[v_caller_private_profile];
    ELSIF NOT v_caller_private_profile = ANY(p_student_profile_ids) THEN
        p_student_profile_ids := p_student_profile_ids || v_caller_private_profile;
    END IF;

    -- 5. Every participant must be an active member of the same class.
    --    Done with a single anti-join.
    SELECT count(*)
      INTO v_invalid_count
      FROM unnest(p_student_profile_ids) AS pid(id)
     WHERE NOT EXISTS (
        SELECT 1
          FROM public.user_roles ur
         WHERE ur.private_profile_id = pid.id
           AND ur.class_id = v_class_id
           AND ur.disabled = false
     );
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION '% participant(s) are not members of this class', v_invalid_count
            USING ERRCODE = '42501';
    END IF;

    -- 6. Solo-request uniqueness: at most one open request per (queue,
    --    creator, privacy) combination. Matches the legacy client check.
    IF array_length(p_student_profile_ids, 1) = 1
       AND p_student_profile_ids[1] = v_caller_private_profile THEN
        SELECT count(*)
          INTO v_existing_solo_count
          FROM public.help_requests hr
         WHERE hr.help_queue = p_help_queue_id
           AND hr.created_by = v_caller_private_profile
           AND hr.is_private = p_is_private
           AND hr.status IN ('open', 'in_progress')
           AND NOT EXISTS (
               SELECT 1
                 FROM public.help_request_students hrs
                WHERE hrs.help_request_id = hr.id
                  AND hrs.profile_id <> v_caller_private_profile
           );
        IF v_existing_solo_count > 0 THEN
            RAISE EXCEPTION 'you already have a % solo help request in this queue',
                CASE WHEN p_is_private THEN 'private' ELSE 'public' END
                USING ERRCODE = '23505';
        END IF;
    END IF;

    -- 7. Optional template / submission ownership checks. NULL passes.
    IF p_template_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.help_request_templates t
            WHERE t.id = p_template_id AND t.class_id = v_class_id
       ) THEN
        RAISE EXCEPTION 'template % is not in class %', p_template_id, v_class_id
            USING ERRCODE = '22023';
    END IF;
    IF p_referenced_submission_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.submissions s
            WHERE s.id = p_referenced_submission_id AND s.class_id = v_class_id
       ) THEN
        RAISE EXCEPTION 'referenced submission % is not in class %', p_referenced_submission_id, v_class_id
            USING ERRCODE = '22023';
    END IF;

    -- followup_to must be a request in this class that the caller took part in. The
    -- form only offers the caller's own resolved/closed requests, but the value also
    -- arrives from a ?followup_to= URL parameter, so it is attacker-controlled and the
    -- column has no FK of its own until this migration adds one. Reject rather than
    -- silently drop, so a stale link surfaces instead of quietly losing the link.
    IF p_followup_to IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM public.help_requests prev
             JOIN public.help_request_students prev_s
               ON prev_s.help_request_id = prev.id
            WHERE prev.id = p_followup_to
              AND prev.class_id = v_class_id
              AND prev_s.profile_id = v_caller_private_profile
       ) THEN
        RAISE EXCEPTION 'followup_to % is not one of your help requests in class %', p_followup_to, v_class_id
            USING ERRCODE = '22023';
    END IF;

    -- 8. Insert the help_requests row. Triggers (broadcast, channel
    --    pre-creation, etc.) fire here as part of the transaction.
    INSERT INTO public.help_requests (
        class_id, help_queue, created_by, request, is_private,
        location_type, status, template_id, referenced_submission_id,
        is_video_live, followup_to
    )
    VALUES (
        v_class_id, p_help_queue_id, v_caller_private_profile, p_request, p_is_private,
        p_location_type, 'open', p_template_id, p_referenced_submission_id,
        false, p_followup_to
    )
    RETURNING id INTO v_help_request_id;

    -- 9. Participant memberships.
    FOREACH v_student IN ARRAY p_student_profile_ids LOOP
        INSERT INTO public.help_request_students (help_request_id, profile_id, class_id)
        VALUES (v_help_request_id, v_student, v_class_id);
    END LOOP;

    -- 10. Initial chat message mirroring the request body so the chat
    --     view shows the question without a follow-up round-trip.
    INSERT INTO public.help_request_messages (
        help_request_id, class_id, author, message, instructors_only, reply_to_message_id
    )
    VALUES (
        v_help_request_id, v_class_id, v_caller_private_profile, p_request, false, NULL
    );

    -- 11. Optional file references. p_file_references is an array of
    --     {submission_file_id, line_number, assignment_id, submission_id}.
    --     Missing/extra keys are tolerated; FKs do the rest.
    IF jsonb_typeof(p_file_references) = 'array' THEN
        FOR v_file IN SELECT * FROM jsonb_array_elements(p_file_references) LOOP
            INSERT INTO public.help_request_file_references (
                help_request_id, class_id, submission_file_id, line_number,
                assignment_id, submission_id
            )
            VALUES (
                v_help_request_id,
                v_class_id,
                NULLIF((v_file->>'submission_file_id'), '')::bigint,
                NULLIF((v_file->>'line_number'), '')::bigint,
                NULLIF((v_file->>'assignment_id'), '')::bigint,
                NULLIF((v_file->>'submission_id'), '')::bigint
            );
        END LOOP;
    END IF;

    -- 12. Activity log row per participant. Best-effort to match the
    --     legacy behavior; if the activity type ever drops or rejects a
    --     row the whole help-request creation rolls back, which is fine
    --     — we'd want to know about that.
    FOREACH v_student IN ARRAY p_student_profile_ids LOOP
        INSERT INTO public.student_help_activity (
            student_profile_id, class_id, help_request_id, activity_type, activity_description
        )
        VALUES (
            v_student, v_class_id, v_help_request_id, 'request_created',
            'Student created a new help request in queue: ' || v_help_queue_name
        );
    END LOOP;

    RETURN v_help_request_id;
END;
$$;

ALTER FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) TO service_role;

COMMENT ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) IS
'Atomically creates a help_requests row plus its help_request_students, help_request_messages, help_request_file_references, and student_help_activity children. Auth + class/queue/membership checks happen inside; the function uses SECURITY DEFINER so callers do not need direct INSERT privileges on the child tables. p_followup_to optionally links the new request to an earlier request in the same class that the caller took part in.';

----------------------------------------------------------------------------------------------------
-- SECTION 3: Audit log RLS, leaderboard anon scoping, and client write revokes
-- (was 20260825140000_audit_findings_2026_08.sql)
----------------------------------------------------------------------------------------------------

-- Restore the audit log's instructor read, scope the leaderboard read to enrolled users, and drop
-- write grants that no client path uses.
--
-- 1. public.audit has RLS enabled and no policy at all. That combination is default-deny, and
--    default-deny on a SELECT returns zero rows and no error, so nothing anywhere reports a
--    failure. 20251228143943_partitioned_audit_system.sql opened with
--    `ALTER TABLE public.audit RENAME TO audit_legacy`; Postgres policies follow a table through a
--    rename, so the `instructors read` policy (added in 20250410173054_handgrading_rest.sql,
--    rewritten in 20250917002948_optimize-submission-rls.sql) went with audit_legacy and now sits
--    on a table holding zero rows. The replacement partitioned table got
--    ENABLE ROW LEVEL SECURITY and never got a CREATE POLICY. The instructor audit view
--    (app/course/[course_id]/manage/course/audit/page.tsx) has rendered "0 Rows" ever since.
--
-- 2. assignment_leaderboard's SELECT policy leads with `auth.uid() IS NULL`, added in
--    20251221230000_assignment_leaderboard.sql under the comment "Allow anonymous users to view
--    all leaderboard entries" and carried forward verbatim by
--    20260120140000_fix_leaderboard_max_score_zero.sql. The anon key is public in a browser app,
--    so that leg returns every class's leaderboard rows to any unauthenticated caller, with no
--    class scoping. Nothing consumes it: the only reader is the leaderboard component on
--    app/course/[course_id]/assignments/[assignment_id]/page.tsx, which is behind the /course auth
--    redirect and additionally requires a class profile.
--
-- 3. anon holds UPDATE and DELETE on live_poll_responses that no policy allows.
--
-- What this migration deliberately does NOT touch: live_polls_select_live
-- (`TO anon, authenticated USING (is_live = true)`). That anon read is load-bearing for the public
-- QR-join page app/poll/[course_id]/page.tsx, which utils/supabase/middleware.ts leaves
-- unauthenticated (only /course* is redirected) and tests/e2e/polls.test.tsx exercises anonymously.
-- 20260817120000_tighten_survey_and_poll_rls.sql already narrowed it from `USING (true)` and
-- recorded why the remainder stays: a live poll's question is readable by anyone who knows the
-- course id, which is inherent to joining by QR code with no token in the URL.


-- ============================================================================
-- 1. audit: restore the instructor read
-- ============================================================================

-- ON THE PARTITIONED PARENT ONLY. Do not replicate this policy per partition.
--
-- Postgres applies the parent's policies to rows read through the parent, and reading through the
-- parent is the only access path anything uses (PostgREST hits /rest/v1/audit). One policy here
-- therefore covers every partition, present and future, with no maintenance.
--
-- Per-partition copies would be actively harmful. audit_maintain_partitions() creates tomorrow's
-- partition on a nightly cron and drops partitions past the 90-day retention, so a per-partition
-- policy set would have to be re-created every night forever -- and the first night that was
-- missed, reads of the newest partition would silently return zero rows again, which is exactly
-- the failure this migration is fixing. If you are here because audit reads look broken, check
-- for a policy on public.audit, not on public.audit_YYYYMMDD.
--
-- The partitions keep their own RLS-enabled/no-policy state, and that is deliberate rather than an
-- oversight: PostgREST also exposes public.audit_YYYYMMDD directly, and no policy there
-- default-denies that path.
--
-- Predicate form is the IN-subquery rather than authorizeforclassinstructor(class_id). The two are
-- semantically identical, but 20250917002948_optimize-submission-rls.sql established the IN form
-- for large tables because the planner hoists it into a single hashed SubPlan, where the STABLE
-- helper is invoked per candidate row. audit grows by every audited write in every class.
DROP POLICY IF EXISTS "instructors read" ON public.audit;

CREATE POLICY "instructors read"
  ON public.audit
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    class_id IN (
      SELECT up.class_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.role = 'instructor'
    )
  );

COMMENT ON TABLE public.audit IS
  'Partitioned audit trail. Read policy lives on this parent table only -- see '
  '20260825140000_audit_findings_2026_08.sql before adding one to a partition.';

-- Client roles have no reason to write the audit trail. It is written exclusively by
-- audit_statement_trigger(), which is SECURITY DEFINER owned by postgres; postgres also owns
-- public.audit and relforcerowsecurity is false, so that trigger bypasses RLS and uses its own
-- privileges. Revoking here does not affect it.
--
-- TRUNCATE is the one that matters. RLS does not constrain TRUNCATE at all -- it is authorized by
-- grant alone -- so `authenticated` holding TRUNCATE on the audit trail means the no-policy
-- default-deny above was never protecting the rows from deletion, only from being read.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit FROM anon, authenticated;

-- Partitions carry their own grants: CREATE TABLE ... PARTITION OF does not inherit privileges
-- from the parent, and Supabase's default privileges hand each new table full rights on anon and
-- authenticated. Revoke on the ones that exist now.
--
-- Partitions created later are handled by audit_maintain_partitions() below, which is replaced
-- in this migration to revoke on each partition it creates. Without that, the protection would
-- decay within a day: tomorrow's partition would be created with TRUNCATE granted again.
DO $$
DECLARE
    partition_name text;
BEGIN
    FOR partition_name IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename ~ '^audit_[0-9]{8}$'
    LOOP
        EXECUTE format(
            'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated',
            partition_name
        );
    END LOOP;
END $$;


-- audit_maintain_partitions() runs daily and creates partitions for the next 7 days. Because
-- CREATE TABLE ... PARTITION OF takes Supabase's default privileges rather than the parent's,
-- every partition it made would arrive with INSERT/UPDATE/DELETE/TRUNCATE granted to anon and
-- authenticated -- reopening, one day at a time, exactly what the REVOKE above closes. RLS
-- covers the DML; TRUNCATE is not subject to RLS, so it needs the grant removed.
--
-- Body is otherwise unchanged from 20251228143943_partitioned_audit_system.sql. search_path is
-- pinned while we are here: the function is SECURITY DEFINER and had no search_path set.
CREATE OR REPLACE FUNCTION public.audit_maintain_partitions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
    partition_date date;
    partition_name text;
    start_date timestamptz;
    end_date timestamptz;
    old_partition_name text;
BEGIN
    -- Create partitions for next 7 days (if they don't exist)
    FOR i IN 0..7 LOOP
        partition_date := CURRENT_DATE + i;
        partition_name := 'audit_' || to_char(partition_date, 'YYYYMMDD');
        start_date := partition_date;
        end_date := partition_date + 1;

        IF NOT EXISTS (
            SELECT 1 FROM pg_class
            WHERE relname = partition_name
            AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        ) THEN
            EXECUTE format(
                'CREATE TABLE public.%I PARTITION OF public.audit
                 FOR VALUES FROM (%L) TO (%L)',
                partition_name, start_date, end_date
            );
            -- Enable RLS on newly created partition
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
            -- Client roles never write the audit trail: it is written by audit_statement_trigger(),
            -- which is SECURITY DEFINER and owned by postgres. TRUNCATE especially must not be
            -- granted, since no policy can restrain it.
            EXECUTE format(
                'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated',
                partition_name
            );
        END IF;
    END LOOP;

    -- Drop partitions older than 90 days (3 months)
    FOR old_partition_name IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename LIKE 'audit_%'
        AND tablename ~ '^audit_[0-9]{8}$'
        AND to_date(substring(tablename from 7 for 8), 'YYYYMMDD') < CURRENT_DATE - 90
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', old_partition_name);
    END LOOP;
END;
$function$;


-- ============================================================================
-- 2. assignment_leaderboard: drop the unauthenticated read
-- ============================================================================

-- authorizeforclass(class_id) is exactly the surviving leg's semantics -- any user_privileges row
-- for the class, i.e. any enrolled member regardless of role -- expressed with the repo's standard
-- helper. The policy is scoped TO authenticated because with the anon leg gone there is no
-- unauthenticated caller it should ever admit.
DROP POLICY IF EXISTS "Users can view leaderboard in their class" ON public.assignment_leaderboard;

CREATE POLICY "Users can view leaderboard in their class"
  ON public.assignment_leaderboard
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (public.authorizeforclass(class_id));

REVOKE SELECT ON public.assignment_leaderboard FROM anon;

-- No client role writes this table: the only policy on it is the SELECT above, and the rows are
-- maintained by the autograder through service_role. The write grants are therefore unreachable
-- for anon and authenticated -- except TRUNCATE, which RLS does not constrain at all, so `anon`
-- holding it means the whole leaderboard was droppable by grant alone.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assignment_leaderboard FROM anon, authenticated;


-- ============================================================================
-- 3. live_poll_responses: drop grants no policy backs
-- ============================================================================

-- anon may only INSERT, and only through live_polls_responses_insert, whose WITH CHECK
-- (can_access_poll_response) enforces require_login and profile ownership. The UPDATE and DELETE
-- grants are unreachable today because no policy admits them; revoking them means a future
-- permissive policy cannot silently widen anon's reach to editing or deleting submitted responses.
REVOKE UPDATE, DELETE ON public.live_poll_responses FROM anon;

-- TRUNCATE again: not constrained by RLS, and nothing needs it. Staff delete individual responses
-- through live_polls_responses_all_staff, which is unaffected.
REVOKE TRUNCATE ON public.live_poll_responses FROM anon, authenticated;

-- live_polls itself: the SELECT grant stays, because live_polls_select_live and the public poll
-- page depend on it. Everything else anon holds here is unreachable -- the INSERT/UPDATE/DELETE
-- policies are all TO authenticated behind authorizeforclassgrader -- except TRUNCATE, which RLS
-- does not constrain, so anon could drop every poll in every class. Staff keep row-level DML
-- through their policies; nothing needs TRUNCATE.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.live_polls FROM anon;
REVOKE TRUNCATE ON public.live_polls FROM authenticated;

-- A column-grant trim on live_polls was considered and rejected. anon reads live_polls only to
-- render the public poll page, and needs nothing there beyond id/class_id/question/is_live/
-- require_login, so narrowing the grant away from created_by looked free. It is not: that page
-- issues .select("*") (app/poll/[course_id]/page.tsx), PostgREST passes `*` through rather than
-- expanding it to the readable columns, and Postgres rejects SELECT * outright when the role holds
-- only column-level grants. Verified against the running stack -- the trim turns the public poll
-- page into `42501 permission denied for table live_polls`. Trimming the grant requires first
-- replacing that .select("*") with an explicit column list.

----------------------------------------------------------------------------------------------------
-- SECTION 4: Due dates: include exceptions, and default a NULL lab end_time
-- (was 20260825140000_audit_findings_2026_08.sql)
----------------------------------------------------------------------------------------------------

-- Two related due-date bugs: student-facing surfaces showed a deadline that was neither the one
-- the assignment page showed nor the one submission enforcement used.
--
-- Bug 1: extensions were dropped from the dashboard's deadline.
--   public.assignments_with_effective_due_dates.due_date and
--   public.get_assignments_for_student_dashboard.due_date both called
--   calculate_effective_due_date, which only applies lab-section offsets and never reads
--   assignment_due_date_exceptions. The course dashboard filters that column with
--   `.gte("due_date", now)` (lib/ssr-course-dashboard.ts) and renders it as "Due"
--   (app/course/[course_id]/studentDashboard.tsx), so a student holding an extension saw a future
--   deadline on the assignment detail page (which computes it client-side in
--   hooks/useCourseController.tsx `useAssignmentDueDate`) and an EMPTY upcoming list -- while
--   submission enforcement, which goes through calculate_final_due_date, would still have
--   accepted the work. The Assignments tab had the same root cause via the RPC and bucketed the
--   extended assignment as past-due.
--
--   Fix: both surfaces now select calculate_final_due_date(assignment, student, group), the
--   function that already wraps calculate_effective_due_date and adds the exception hours/minutes.
--   Nothing else reads either due_date column, so the semantics change is contained; the RPC's
--   exception_* columns are unchanged (they remain most-recent-exception metadata, and no caller
--   reads them today).
--
-- Bug 2: a lab section with no end_time silently disabled its own lab offset.
--   calculate_effective_due_date builds its meeting timestamps by string-concatenating
--   lab_sections.end_time. That column is nullable -- the lab-section form leaves it optional
--   (app/course/[course_id]/manage/course/lab-sections/page.tsx) and course-import-sis writes NULL
--   whenever a section's meeting_times does not match any of its time patterns -- and a NULL made
--   `(meeting_date || ' ' || end_time)::timestamp` NULL, so the `<= due_date` predicate was NULL
--   for every meeting, no meeting matched, and the student fell back to the plain assignment due
--   date with no error. Meanwhile the assignment form's "Lab Section Due Date Preview" substitutes
--   23:59:59 and showed the instructor a deadline that would never apply.
--
--   Fix: default a missing end_time to 23:59:59 (end of the meeting day), matching that preview.
--   The same default is now applied in useAssignmentDueDate so all three paths agree.
--
--   Deployment note: any existing lab section with a NULL end_time will see its students'
--   deadlines move EARLIER (from the plain due date to end-of-meeting-day + minutes_due_after_lab)
--   for assignments that use minutes_due_after_lab. Audit before deploying:
--     SELECT ls.id, ls.class_id, c.name AS class_name, ls.name, ls.day_of_week, ls.sis_crn
--       FROM public.lab_sections ls JOIN public.classes c ON c.id = ls.class_id
--      WHERE ls.end_time IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 1. calculate_effective_due_date: tolerate a NULL lab-section end_time.
--
-- Body copied verbatim from the only prior definition
-- (20250712142950_lab-sections.sql) except for the lab_end_time local and the two
-- concatenations that now read it. Signature, volatility and security are unchanged, so the
-- existing GRANTs and every dependent view (assignment_overview, the regression-test and
-- what-if views, calculate_final_due_date) survive CREATE OR REPLACE without a drop.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."calculate_effective_due_date"(
    "assignment_id_param" bigint,
    "student_profile_id_param" uuid
) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
    assignment_record RECORD;
    student_lab_section_id bigint;
    most_recent_lab_meeting_date date;
    lab_section_record RECORD;
    course_record RECORD;
    lab_based_due_date timestamp with time zone;
    lab_meeting_timestamp timestamp with time zone;
    lab_end_time time;
BEGIN
    -- Get assignment details
    SELECT * INTO assignment_record
    FROM public.assignments
    WHERE id = assignment_id_param;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment with id % not found', assignment_id_param;
    END IF;

    -- If assignment doesn't use lab-based scheduling, return original due date
    IF assignment_record.minutes_due_after_lab IS NULL THEN
        RETURN assignment_record.due_date;
    END IF;

    -- Get student's lab section for this class
    SELECT lab_section_id INTO student_lab_section_id
    FROM public.user_roles
    WHERE private_profile_id = student_profile_id_param
    AND class_id = assignment_record.class_id
    AND lab_section_id IS NOT NULL;

    -- If student is not in a lab section, fall back to original due date
    IF student_lab_section_id IS NULL THEN
        RETURN assignment_record.due_date;
    END IF;

    -- Get lab section details (for end_time)
    SELECT * INTO lab_section_record
    FROM public.lab_sections
    WHERE id = student_lab_section_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lab section with id % not found', student_lab_section_id;
    END IF;

    -- Get course details (for time_zone)
    SELECT * INTO course_record
    FROM public.classes
    WHERE id = assignment_record.class_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class with id % not found', assignment_record.class_id;
    END IF;

    -- end_time is nullable, and concatenating a NULL into the meeting timestamp below would
    -- NULL the whole comparison, match no meeting, and silently skip the lab offset. A section
    -- with no recorded end time is treated as ending at the end of its meeting day, which is
    -- what the assignment form's Lab Section Due Date Preview already shows.
    lab_end_time := COALESCE(lab_section_record.end_time, TIME '23:59:59');

    -- Find the most recent lab section meeting before the assignment's original due date
    -- Convert meeting date + lab section end time to timestamp in course timezone
    SELECT meeting_date INTO most_recent_lab_meeting_date
    FROM public.lab_section_meetings lsm
    WHERE lsm.lab_section_id = student_lab_section_id
    AND (
        (lsm.meeting_date::text || ' ' || lab_end_time::text)::timestamp AT TIME ZONE course_record.time_zone
    ) <= assignment_record.due_date
    AND NOT lsm.cancelled
    ORDER BY lsm.meeting_date DESC
    LIMIT 1;

    -- If no lab meeting found before due date, fall back to original due date
    IF most_recent_lab_meeting_date IS NULL THEN
        RETURN assignment_record.due_date;
    END IF;

    -- Combine meeting date with lab section end time and apply course time zone
    lab_meeting_timestamp := (
        most_recent_lab_meeting_date::text || ' ' || lab_end_time::text
    )::timestamp AT TIME ZONE course_record.time_zone;

    -- Calculate lab-based due date
    lab_based_due_date := lab_meeting_timestamp
                         + (assignment_record.minutes_due_after_lab * INTERVAL '1 minute');

    -- Return the lab-based due date
    RETURN lab_based_due_date;
END;
$$;

COMMENT ON FUNCTION "public"."calculate_effective_due_date"(bigint, uuid) IS 'Calculates the effective due date for a student on an assignment, considering lab-based scheduling if configured. A lab section with a NULL end_time is treated as ending at 23:59:59 on its meeting day (matching the assignment form preview). Does NOT include due-date exceptions -- use calculate_final_due_date for the deadline a student is actually held to.';

-- ---------------------------------------------------------------------------------------------
-- 2. assignments_with_effective_due_dates.due_date becomes the FINAL per-student due date.
--
-- Copied verbatim from the latest definition
-- (20260530120100_add-suggested-due-date-to-effective-view.sql) except the due_date expression
-- and the new LEFT JOIN LATERAL that resolves the student's group for this assignment.
-- Column list, order and types are unchanged, so CREATE OR REPLACE VIEW is valid and the
-- generated Database types do not move. security_invoker preserved.
--
-- The lateral cannot fan out (LIMIT 1, and unique_assignment_group_member already makes
-- (assignment_id, profile_id) unique) and is index-only via
-- idx_assignment_groups_members_profile_assignment_covering (profile_id, assignment_id)
-- INCLUDE (assignment_group_id).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW "public"."assignments_with_effective_due_dates"
WITH ("security_invoker" = 'true') AS
 SELECT a.id,
    a.created_at,
    a.class_id,
    a.title,
    a.release_date,
    public.calculate_final_due_date(a.id, ur.private_profile_id, agm.assignment_group_id) AS due_date,
    a.student_repo_prefix,
    a.total_points,
    a.has_autograder,
    a.has_handgrader,
    a.description,
    a.slug,
    a.template_repo,
    a.allow_student_formed_groups,
    a.group_config,
    a.group_formation_deadline,
    a.max_group_size,
    a.min_group_size,
    a.archived_at,
    a.autograder_points,
    a.grading_rubric_id,
    a.max_late_tokens,
    a.latest_template_sha,
    a.meta_grading_rubric_id,
    a.self_review_rubric_id,
    a.self_review_setting_id,
    a.gradebook_column_id,
    a.minutes_due_after_lab,
    ur.private_profile_id AS student_profile_id,
    a.suggested_due_date
   FROM assignments a
     CROSS JOIN user_roles ur
     LEFT JOIN LATERAL (
       SELECT m.assignment_group_id
         FROM public.assignment_groups_members m
        WHERE m.profile_id = ur.private_profile_id
          AND m.assignment_id = a.id
        LIMIT 1
     ) agm ON true
  WHERE ur.class_id = a.class_id AND ur.role = 'student'::app_role AND a.archived_at IS NULL;

COMMENT ON VIEW "public"."assignments_with_effective_due_dates" IS 'View showing all assignment columns but with due_date replaced by the final per-student due date (lab-aware effective date plus any due-date exceptions)';
COMMENT ON COLUMN "public"."assignments_with_effective_due_dates"."due_date" IS 'Final per-student due date: lab-aware effective date plus any assignment_due_date_exceptions (extensions / late tokens) for the student or their group';
COMMENT ON COLUMN "public"."assignments_with_effective_due_dates"."student_profile_id" IS 'Student profile ID for filtering assignments by student';

-- ---------------------------------------------------------------------------------------------
-- 3. get_assignments_for_student_dashboard.due_date becomes the FINAL per-student due date.
--
-- Same bug and same fix as the view above, for the Assignments tab
-- (app/course/[course_id]/assignments/studentAssignmentsList.tsx). Everything below is copied
-- verbatim from the latest definition
-- (20260715120100_hide_unreleased_assignments_from_student_dashboard.sql -- which added the
-- release gate in the final WHERE) except the due_date expression and the new student_group
-- join that feeds it. Basing on that version preserves the release gate and the
-- active-submission preference.
--
-- The exception_* columns are deliberately untouched: they expose the single most recent
-- exception row (ORDER BY created_at DESC LIMIT 1) as metadata, whereas the deadline needs the
-- SUM of every exception -- which is exactly what calculate_final_due_date does. No frontend
-- reads the exception_* columns today, so there is nothing to double-count.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_assignments_for_student_dashboard(
  p_class_id bigint,
  p_student_profile_id uuid
) RETURNS TABLE (
  id bigint,
  created_at timestamptz,
  class_id bigint,
  title text,
  release_date timestamptz,
  due_date timestamptz,
  student_repo_prefix text,
  total_points numeric,
  has_autograder boolean,
  has_handgrader boolean,
  description text,
  slug text,
  template_repo text,
  allow_student_formed_groups boolean,
  group_config public.assignment_group_mode,
  group_formation_deadline timestamptz,
  max_group_size integer,
  min_group_size integer,
  archived_at timestamptz,
  autograder_points bigint,
  grading_rubric_id bigint,
  max_late_tokens integer,
  latest_template_sha text,
  meta_grading_rubric_id bigint,
  self_review_rubric_id bigint,
  self_review_setting_id bigint,
  gradebook_column_id bigint,
  minutes_due_after_lab integer,
  allow_not_graded_submissions boolean,
  student_profile_id uuid,
  student_user_id uuid,
  submission_id bigint,
  submission_created_at timestamptz,
  submission_is_active boolean,
  submission_ordinal integer,
  grader_result_id bigint,
  grader_result_score numeric,
  grader_result_max_score numeric,
  repository_id bigint,
  repository text,
  is_github_ready boolean,
  assignment_self_review_setting_id bigint,
  self_review_enabled boolean,
  self_review_deadline_offset bigint,
  review_assignment_id bigint,
  review_submission_id bigint,
  submission_review_id bigint,
  submission_review_completed_at timestamptz,
  due_date_exception_id bigint,
  exception_hours integer,
  exception_minutes integer,
  exception_tokens_consumed integer,
  exception_created_at timestamptz,
  exception_creator_id uuid,
  exception_note text,
  grading_submission_review_id bigint,
  grading_submission_review_completed_at timestamptz,
  grading_total_score numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  -- Authorization gate (top of function, single explicit check).
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.user_id = auth.uid()
      AND ur.disabled = false
      AND (
        (ur.role = 'student'::public.app_role AND ur.private_profile_id = p_student_profile_id)
        OR ur.role = 'instructor'::public.app_role
        OR ur.role = 'grader'::public.app_role
      )
  ) THEN
    RAISE EXCEPTION 'not authorized to read assignments dashboard for this student'
      USING ERRCODE = '42501';
  END IF;

  -- Body: same CTE chain that the previous view used, but `ur_students` is bounded
  -- to the single requested (class, student) so every downstream join is O(assignments)
  -- rather than O(class_students * assignments).
  RETURN QUERY
  WITH ur_students AS (
    SELECT ur.class_id,
           ur.private_profile_id AS student_profile_id,
           ur.user_id AS student_user_id
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.private_profile_id = p_student_profile_id
      AND ur.role = 'student'::public.app_role
      AND ur.disabled = false
  ), latest_submission AS (
    SELECT a.id AS assignment_id,
           s_ind.id AS submission_id,
           s_ind.created_at AS submission_created_at,
           s_ind.is_active AS submission_is_active,
           s_ind.ordinal AS submission_ordinal,
           ur.student_profile_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.is_active, s.ordinal
        FROM public.submissions s
        WHERE s.assignment_id = a.id
          AND s.profile_id = ur.student_profile_id
          AND s.assignment_group_id IS NULL
        -- Prefer the active submission; fall back to most recent. The grade shown should be
        -- the active/graded submission's, not a later not-for-grading scratch submission's.
        ORDER BY s.is_active DESC, s.created_at DESC
        LIMIT 1
    ) s_ind ON TRUE
  ), student_group AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           agm.assignment_group_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN public.assignment_groups_members agm
      ON agm.assignment_id = a.id
     AND agm.profile_id = ur.student_profile_id
  ), latest_group_submission AS (
    SELECT sg.assignment_id,
           sg.student_profile_id,
           s_grp.id AS submission_id,
           s_grp.created_at AS submission_created_at,
           s_grp.is_active AS submission_is_active,
           s_grp.ordinal AS submission_ordinal
    FROM student_group sg
    LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.is_active, s.ordinal
        FROM public.submissions s
        WHERE s.assignment_id = sg.assignment_id
          AND s.assignment_group_id = sg.assignment_group_id
        -- Prefer the active submission; fall back to most recent (see individual branch above).
        ORDER BY s.is_active DESC, s.created_at DESC
        LIMIT 1
    ) s_grp ON TRUE
  ), chosen_submission AS (
    SELECT DISTINCT ON (assignment_id, student_profile_id)
           assignment_id,
           student_profile_id,
           submission_id,
           submission_created_at,
           submission_is_active,
           submission_ordinal
    FROM (
        SELECT ls.assignment_id, ls.student_profile_id, ls.submission_id,
               ls.submission_created_at, ls.submission_is_active, ls.submission_ordinal
        FROM latest_submission ls
        UNION ALL
        SELECT lgs.assignment_id, lgs.student_profile_id, lgs.submission_id,
               lgs.submission_created_at, lgs.submission_is_active, lgs.submission_ordinal
        FROM latest_group_submission lgs
    ) x
    -- A student is in at most one mode per assignment, so exactly one branch yields a real
    -- row (the other has NULLs). NULLS LAST keeps the real row; the is_active tiebreaker
    -- matches the per-mode LATERAL preference for the active submission.
    ORDER BY assignment_id, student_profile_id,
             submission_is_active DESC NULLS LAST, submission_created_at DESC NULLS LAST
  ), grader_result_for_submission AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           gr.id AS grader_result_id,
           gr.score AS grader_result_score,
           gr.max_score AS grader_result_max_score
    FROM chosen_submission cs
    LEFT JOIN public.grader_results gr ON gr.submission_id = cs.submission_id
  ), grading_review_for_submission AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           sr.id AS grading_submission_review_id,
           sr.completed_at AS grading_submission_review_completed_at,
           COALESCE(
             CASE
               WHEN NULLIF(sr.per_student_grading_totals ->> cs.student_profile_id::text, '') ~ '^[+-]?[0-9]+(\.[0-9]+)?$'
               THEN (NULLIF(sr.per_student_grading_totals ->> cs.student_profile_id::text, ''))::numeric
               ELSE NULL
             END,
             CASE
               WHEN NULLIF(sr.individual_scores ->> cs.student_profile_id::text, '') ~ '^[+-]?[0-9]+(\.[0-9]+)?$'
               THEN (NULLIF(sr.individual_scores ->> cs.student_profile_id::text, ''))::numeric
               ELSE NULL
             END,
             sr.total_score
           ) AS grading_total_score
    FROM chosen_submission cs
    LEFT JOIN public.submissions s ON s.id = cs.submission_id
    -- Release gate: only join the grading review once it is released, mirroring the
    -- student RLS the prior security_invoker view relied on. Unreleased reviews yield
    -- NULL score columns and the frontend falls back to the autograder score.
    LEFT JOIN public.submission_reviews sr ON sr.id = s.grading_review_id AND sr.released = true
  ), chosen_repository AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           repo.repository_id,
           repo.repository,
           repo.is_github_ready
    FROM chosen_submission cs
    LEFT JOIN student_group sg
      ON sg.assignment_id = cs.assignment_id AND sg.student_profile_id = cs.student_profile_id
    LEFT JOIN public.submissions sub ON sub.id = cs.submission_id
    LEFT JOIN LATERAL (
        SELECT r.id AS repository_id, r.repository, r.is_github_ready
        FROM public.repositories r
        WHERE r.assignment_id = cs.assignment_id
          AND (
            (sub.id IS NOT NULL AND sub.assignment_group_id IS NOT NULL
             AND r.assignment_group_id = sub.assignment_group_id)
            OR (sub.id IS NOT NULL AND sub.assignment_group_id IS NULL AND r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL)
            OR (
              sub.id IS NULL
              AND (
                (sg.assignment_group_id IS NOT NULL AND r.assignment_group_id = sg.assignment_group_id)
                OR (r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL)
              )
            )
          )
        ORDER BY
          CASE
            WHEN sub.id IS NOT NULL AND sub.assignment_group_id IS NOT NULL
                 AND r.assignment_group_id = sub.assignment_group_id THEN 0
            WHEN sub.id IS NOT NULL AND sub.assignment_group_id IS NULL
                 AND r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL THEN 0
            WHEN sub.id IS NULL AND r.assignment_group_id IS NOT NULL THEN 1
            WHEN sub.id IS NULL AND r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL THEN 2
            ELSE 3
          END,
          r.id
        LIMIT 1
    ) repo ON TRUE
  ), review_info AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ri.review_assignment_id,
           ri.review_submission_id,
           ri.submission_review_id,
           ri.submission_review_completed_at
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT ra.id AS review_assignment_id,
               ra.submission_id AS review_submission_id,
               sr.id AS submission_review_id,
               sr.completed_at AS submission_review_completed_at
        FROM public.review_assignments ra
        LEFT JOIN public.submission_reviews sr ON sr.id = ra.submission_review_id
        WHERE ra.assignment_id = a.id
          AND ra.assignee_profile_id = ur.student_profile_id
          -- Release gate: mirror the review_assignments RLS the prior security_invoker view
          -- relied on, so an unreleased self/peer review's ids don't surface on the dashboard
          -- (the frontend renders a clickable "Self Review for X" row off review_assignment_id).
          AND (ra.release_date IS NULL OR ra.release_date <= now())
        ORDER BY ra.created_at DESC
        LIMIT 1
    ) ri ON TRUE
  ), due_date_ex AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ade.id AS due_date_exception_id,
           ade.hours AS exception_hours,
           ade.minutes AS exception_minutes,
           ade.tokens_consumed AS exception_tokens_consumed,
           ade.created_at AS exception_created_at,
           ade.creator_id AS exception_creator_id,
           ade.note AS exception_note
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT ade.*
        FROM public.assignment_due_date_exceptions ade
        WHERE ade.assignment_id = a.id
          AND (ade.student_id = ur.student_profile_id OR
               ade.assignment_group_id IN (
                   SELECT agm.assignment_group_id
                   FROM public.assignment_groups_members agm
                   WHERE agm.profile_id = ur.student_profile_id
                     AND agm.assignment_id = a.id
               ))
        ORDER BY ade.created_at DESC
        LIMIT 1
    ) ade ON TRUE
  )
  SELECT a.id,
         a.created_at,
         a.class_id,
         a.title,
         a.release_date,
         public.calculate_final_due_date(a.id, ur.student_profile_id, sg.assignment_group_id) AS due_date,
         a.student_repo_prefix,
         a.total_points,
         a.has_autograder,
         a.has_handgrader,
         a.description,
         a.slug,
         a.template_repo,
         a.allow_student_formed_groups,
         a.group_config,
         a.group_formation_deadline,
         a.max_group_size,
         a.min_group_size,
         a.archived_at,
         a.autograder_points,
         a.grading_rubric_id,
         a.max_late_tokens,
         a.latest_template_sha,
         a.meta_grading_rubric_id,
         a.self_review_rubric_id,
         a.self_review_setting_id,
         a.gradebook_column_id,
         a.minutes_due_after_lab,
         a.allow_not_graded_submissions,
         ur.student_profile_id,
         ur.student_user_id,
         cs.submission_id,
         cs.submission_created_at,
         cs.submission_is_active,
         cs.submission_ordinal,
         gr.grader_result_id,
         gr.grader_result_score,
         gr.grader_result_max_score,
         sr.repository_id,
         sr.repository,
         sr.is_github_ready,
         asrs.id AS assignment_self_review_setting_id,
         asrs.enabled AS self_review_enabled,
         asrs.deadline_offset AS self_review_deadline_offset,
         ri.review_assignment_id,
         ri.review_submission_id,
         ri.submission_review_id,
         ri.submission_review_completed_at,
         de.due_date_exception_id,
         de.exception_hours,
         de.exception_minutes,
         de.exception_tokens_consumed,
         de.exception_created_at,
         de.exception_creator_id,
         de.exception_note,
         gv.grading_submission_review_id,
         gv.grading_submission_review_completed_at,
         gv.grading_total_score
  FROM public.assignments a
  JOIN ur_students ur ON ur.class_id = a.class_id
  LEFT JOIN chosen_submission cs
    ON cs.assignment_id = a.id AND cs.student_profile_id = ur.student_profile_id
  LEFT JOIN grader_result_for_submission gr
    ON gr.assignment_id = a.id AND gr.student_profile_id = ur.student_profile_id
  LEFT JOIN grading_review_for_submission gv
    ON gv.assignment_id = a.id AND gv.student_profile_id = ur.student_profile_id
  LEFT JOIN chosen_repository sr
    ON sr.assignment_id = a.id AND sr.student_profile_id = ur.student_profile_id
  LEFT JOIN public.assignment_self_review_settings asrs
    ON asrs.id = a.self_review_setting_id
  LEFT JOIN review_info ri
    ON ri.assignment_id = a.id AND ri.student_profile_id = ur.student_profile_id
  -- student_group is the same CTE chosen_repository already uses; it is LEFT JOINed on
  -- (assignment_id, profile_id), which unique_assignment_group_member makes unique, so it
  -- cannot fan out. It supplies the group whose exceptions calculate_final_due_date must add.
  LEFT JOIN student_group sg
    ON sg.assignment_id = a.id AND sg.student_profile_id = ur.student_profile_id
  LEFT JOIN due_date_ex de
    ON de.assignment_id = a.id AND de.student_profile_id = ur.student_profile_id
  -- Release gate: hide assignments not yet released from the student dashboard. A NULL
  -- release_date is treated as released, matching the individual-assignment page redirect.
  WHERE a.archived_at IS NULL
    AND (a.release_date IS NULL OR a.release_date <= now());
END
$$;

REVOKE ALL ON FUNCTION public.get_assignments_for_student_dashboard(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_assignments_for_student_dashboard(bigint, uuid) TO authenticated;

----------------------------------------------------------------------------------------------------
-- SECTION 5: Discussion anonymity toggle: correct the uuid/text declarations
-- (was 20260825140000_audit_findings_2026_08.sql)
----------------------------------------------------------------------------------------------------

-- Fix public.toggle_discussion_thread_author_anonymity: declared uuid variables as text.
--
-- Introduced in 20260115201143_add_toggle_discussion_anonymity_rpc.sql, which declared
-- v_current_author_id and v_target_author_id as `text` (:16-17) and then compared them to
-- the uuid columns user_roles.private_profile_id / .public_profile_id (:63). plpgsql
-- resolves that comparison at execution time, so the function parsed and deployed fine
-- but has raised on every single call since:
--
--   ERROR:  operator does not exist: uuid = text
--   CONTEXT:  PL/pgSQL function public.toggle_discussion_thread_author_anonymity(bigint,boolean) line 47
--
-- It therefore never once reached the two `SET author = v_target_author_id` statements
-- (:84, :95), which would also have been assigning text into a uuid column. The staff
-- "make this post anonymous / named" control in the discussion UI
-- (app/course/[course_id]/discussion/[root_id]/page.tsx) has been dead since 2026-01-15.
--
-- This is a types-only correction: the body below is verbatim from 20260115201143 except
-- that the two DECLARE lines now say `uuid`. Everything else -- SECURITY DEFINER, the
-- pinned search_path, the guards, the descendant update, the grant and the comment -- is
-- unchanged, so the diff reviews as exactly "types corrected".

CREATE OR REPLACE FUNCTION public.toggle_discussion_thread_author_anonymity(
  p_thread_id bigint,
  p_make_anonymous boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

  -- Check that the caller is a grader or instructor for this class
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND class_id = v_thread_class_id
      AND disabled = false
      AND role IN ('grader', 'instructor')
  ) INTO v_is_staff;

  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'Access denied: Grader or instructor role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Find the user_roles record that matches the current author
  -- The author could be either private_profile_id or public_profile_id
  --
  -- Deliberately NOT filtered on disabled = false, unlike the staff check above:
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
$$;

-- Grant execute permission to authenticated users
-- Authorization is checked within the function
GRANT EXECUTE ON FUNCTION public.toggle_discussion_thread_author_anonymity(bigint, boolean) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.toggle_discussion_thread_author_anonymity IS
'Toggles the author anonymity for a root discussion thread and all its descendant posts by the same user. Staff (grader/instructor) only. If p_make_anonymous is true, switches to public_profile_id; if false, switches to private_profile_id.';
