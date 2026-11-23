-- #1010: renaming a class section follows manage_roster.
--
-- update_class_section_name() (20260920120000_instructor_rename_class_sections.sql) checked
-- authorizeforclassinstructor. It now checks manage_roster in the section's class, which every
-- default instructor role holds (20261122210300_roster_by_capability.sql), so instructors keep it
-- and an instructor can give it to a custom role such as a Head TA.
--
-- Only the permission check changes. The function still changes nothing but `name`, so sis_crn and
-- the canvas_* ids stay out of reach.

CREATE OR REPLACE FUNCTION public.update_class_section_name(
    p_class_section_id bigint,
    p_name text
)
RETURNS boolean AS $$
DECLARE
    v_class_id bigint;
    v_name text := trim(p_name);
BEGIN
    SET LOCAL search_path = pg_catalog, public;

    SELECT class_id INTO v_class_id
    FROM public.class_sections
    WHERE id = p_class_section_id;

    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Class section not found';
    END IF;

    -- Authorize the real caller. This is SECURITY DEFINER and granted to
    -- `authenticated`, so the class is derived from the row being edited and
    -- never from a caller-supplied parameter.
    IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_roster')) THEN
        RAISE EXCEPTION 'Access denied: manage_roster is required for this course';
    END IF;

    IF v_name IS NULL OR v_name = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    -- The name is rendered in dropdowns, enrollment tables and calendar titles,
    -- none of which have anywhere to put an essay. Bound it at the RPC rather
    -- than trusting the dialog, in the same spirit as the 2000-char cap on
    -- ai_help_feedback's p_comment.
    IF length(v_name) > 100 THEN
        RAISE EXCEPTION 'Section name must be 100 characters or fewer';
    END IF;

    -- `IS DISTINCT FROM` keeps a save-without-editing from bumping updated_at and
    -- firing broadcast_class_sections_realtime for nothing. This is the same
    -- no-op-write problem 20260224140000 fixed for the hourly SIS sync; do not
    -- drop the predicate.
    UPDATE public.class_sections
    SET name = v_name,
        updated_at = now()
    WHERE id = p_class_section_id
      AND name IS DISTINCT FROM v_name;

    -- True means "the section now carries this name", not "a row was written":
    -- a no-op rename is a success, and existence was already checked above.
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.update_class_section_name(bigint, text) FROM public;
REVOKE ALL ON FUNCTION public.update_class_section_name(bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_class_section_name(bigint, text) TO authenticated;

COMMENT ON FUNCTION public.update_class_section_name(bigint, text) IS
'Renames a class section. Needs manage_roster in the owning course; name is the only field it can change.';
