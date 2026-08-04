-- Make create_invitation idempotent against the unconditional UNIQUE (class_id, sis_user_id)
-- constraint (invitations_class_id_sis_user_id_key).
--
-- Previously the function only guarded against an existing *pending* invitation and then blindly
-- INSERTed. When an invitation already existed for the same (class_id, sis_user_id) in any other
-- status ('accepted', 'cancelled', 'dropped'), the guard passed and the INSERT violated the unique
-- constraint — surfacing as "duplicate key value violates unique constraint
-- invitations_class_id_sis_user_id_key" for every caller (the invitation-create edge function and the
-- bulk CSV import RPC). Re-importing a roster or re-inviting a previously-removed student hit this.
--
-- Fix: look up any existing invitation for the pair (the constraint is status-agnostic) and, when
-- one exists in status 'dropped' (removed from the SIS roster), reactivate it in place — reset to
-- 'pending' reusing the existing profile pair, so we never orphan or duplicate profiles (#390) — and
-- refresh the reused private profile's name when a corrected name is supplied. 'dropped' -> 'pending'
-- is the transition wired to trigger_auto_accept_invitation_on_reactivation, so an existing user is
-- actually re-enrolled. For 'pending' / 'accepted' / 'cancelled' we raise "already exists" instead of
-- mutating: 'accepted' would un-accept an enrolled student and 'cancelled' is a deliberate instructor
-- action, and reactivating either to 'pending' would NOT fire the (dropped-only) auto-accept trigger.
-- A transaction-scoped advisory lock serializes concurrent calls for the same pair.
--
-- Callers surface "already exists" as a per-row soft error; the invitation-create edge function's
-- pre-check also short-circuits pending/accepted/cancelled before calling this RPC, so this RAISE is
-- primarily a race-safety net.
CREATE OR REPLACE FUNCTION public.create_invitation(
  p_class_id bigint,
  p_role public.app_role,
  p_sis_user_id integer,
  p_email text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_invited_by uuid DEFAULT auth.uid(),
  p_class_section_id bigint DEFAULT NULL,
  p_lab_section_id bigint DEFAULT NULL,
  p_sis_managed boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_public_profile_id uuid;
    v_private_profile_id uuid;
    v_invitation_id bigint;
    v_existing_id bigint;
    v_existing_status text;
    v_existing_private_profile_id uuid;
    v_display_name text;
    v_adjective text;
    v_noun text;
    v_number integer;
    v_public_name text;
BEGIN
    IF NOT (public.authorizeforclassinstructor(p_class_id) OR public.authorize_for_admin()) THEN
        RAISE EXCEPTION 'Only instructors or admins can create invitations for this class';
    END IF;

    -- Serialize concurrent create_invitation calls for the same (class, sis_user) so the
    -- lookup-then-insert/reactivate below is atomic. createInvitationsBulk fans invitations out
    -- concurrently and duplicate SIS IDs (or simultaneous requests) could otherwise both see "no
    -- pending row" and collide on invitations_class_id_sis_user_id_key, or both reactivate the same
    -- row. The transaction-scoped lock is released automatically at COMMIT/ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtext('create_invitation:' || p_class_id::text || ':' || p_sis_user_id::text));

    -- Look up any existing invitation for this (class, sis_user) — the unique constraint is
    -- unconditional, so status does not matter for conflict detection.
    SELECT id, status, private_profile_id
      INTO v_existing_id, v_existing_status, v_existing_private_profile_id
    FROM public.invitations
    WHERE class_id = p_class_id AND sis_user_id = p_sis_user_id
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        -- Only a 'dropped' invitation (removed from the SIS roster) is reactivatable here, matching
        -- the SIS-sync reactivation semantics. 'pending' already exists; 'accepted' means the user
        -- is/was enrolled (resetting it would un-accept an enrolled student); 'cancelled' is a
        -- deliberate instructor action. For all three we raise so the caller reports "already
        -- exists" rather than silently mutating state. Reactivating 'dropped' -> 'pending' is the
        -- one transition wired to trigger_auto_accept_invitation_on_reactivation, so the user is
        -- actually re-enrolled when they already have an account.
        IF v_existing_status <> 'dropped' THEN
            RAISE EXCEPTION 'Invitation already exists for this user in this class';
        END IF;

        -- Reactivate the dropped invitation in place, reusing its profile pair.
        UPDATE public.invitations
        SET status = 'pending',
            role = p_role,
            email = COALESCE(p_email, email),
            name = COALESCE(p_name, name),
            invited_by = COALESCE(p_invited_by, invited_by),
            class_section_id = p_class_section_id,
            lab_section_id = p_lab_section_id,
            sis_managed = p_sis_managed,
            accepted_at = NULL,
            updated_at = NOW()
        WHERE id = v_existing_id;

        -- Refresh the reused private profile's display name when a (corrected) name is supplied, so
        -- the roster/grading surfaces don't show a stale name after the user enrolls. The public
        -- pseudonym profile is left untouched.
        IF p_name IS NOT NULL AND v_existing_private_profile_id IS NOT NULL THEN
            UPDATE public.profiles
            SET name = p_name
            WHERE id = v_existing_private_profile_id AND is_private_profile = true;
        END IF;

        RETURN v_existing_id;
    END IF;

    v_display_name := COALESCE(p_name, split_part(p_email, '@', 1), p_sis_user_id::text);

    -- If this SIS user is already enrolled in the class, reuse that enrollment's
    -- profile pair so the invitation does not create a duplicate profile (#390).
    SELECT ur.public_profile_id, ur.private_profile_id
      INTO v_public_profile_id, v_private_profile_id
    FROM public.user_roles ur
    JOIN public.users u ON u.user_id = ur.user_id
    WHERE u.sis_user_id = p_sis_user_id
      AND ur.class_id = p_class_id
    LIMIT 1;

    IF v_private_profile_id IS NULL THEN
        -- Generate a collision-resistant random name for the public profile.
        DECLARE
            v_attempts integer := 0;
            v_exists boolean := true;
        BEGIN
            WHILE v_attempts < 20 LOOP
                SELECT word INTO v_adjective FROM public.name_generation_words
                WHERE is_adjective = true ORDER BY random() LIMIT 1;
                SELECT word INTO v_noun FROM public.name_generation_words
                WHERE is_noun = true ORDER BY random() LIMIT 1;
                v_number := floor(random() * 1000)::integer;
                v_public_name := COALESCE(v_adjective, 'random') || '-' || COALESCE(v_noun, 'user') || '-' || v_number;
                SELECT EXISTS (
                    SELECT 1 FROM public.profiles WHERE class_id = p_class_id AND name = v_public_name
                ) INTO v_exists;
                IF NOT v_exists THEN EXIT; END IF;
                v_attempts := v_attempts + 1;
            END LOOP;
            IF v_exists THEN
                v_public_name := v_public_name || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
            END IF;
        END;

        INSERT INTO public.profiles (name, class_id, is_private_profile)
        VALUES (v_public_name, p_class_id, false)
        RETURNING id INTO v_public_profile_id;

        INSERT INTO public.profiles (name, class_id, is_private_profile)
        VALUES (v_display_name, p_class_id, true)
        RETURNING id INTO v_private_profile_id;
    END IF;

    INSERT INTO public.invitations (
        class_id, role, sis_user_id, email, name,
        public_profile_id, private_profile_id, invited_by,
        class_section_id, lab_section_id, sis_managed, status,
        created_at, updated_at
    ) VALUES (
        p_class_id, p_role, p_sis_user_id, p_email, p_name,
        v_public_profile_id, v_private_profile_id, p_invited_by,
        p_class_section_id, p_lab_section_id, p_sis_managed, 'pending',
        NOW(), NOW()
    ) RETURNING id INTO v_invitation_id;

    RETURN v_invitation_id;
END;
$$;
