-- Let instructors rename the class sections in their own course.
--
-- Renaming a class section has been admin-only (admin_update_class_section, gated
-- on authorize_for_admin) because class_sections carries no instructor write
-- policy: the only policy on the table is the "anyone in class reads" SELECT
-- policy from 20250422163743_canvas_sync.sql. Instructors already rename lab
-- sections from /manage/course/lab-sections; this is the equivalent for class
-- sections.
--
-- This is an RPC rather than a new RLS write policy on purpose. A FOR UPDATE
-- policy would also hand instructors sis_crn, campus, meeting_times and the
-- canvas_* ids, and sis_sync_enrollment matches sections on sis_crn -- a
-- rewritten CRN silently detaches a section from its roster. The RPC can only
-- touch `name`.

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
    IF NOT authorizeforclassinstructor(v_class_id) THEN
        RAISE EXCEPTION 'Access denied: Instructor role required for this course';
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
'Renames a class section. Instructors of the owning course only; name is the only field it can change.';


-- class_sections has been wired to ClassRealTimeController in useCourseController
-- since that controller was written, but no broadcast trigger was ever created
-- for the table, so the TableController never receives a change event and a
-- rename would only show up after a reload. Mirror the lab_sections trigger from
-- 20250807043050_course-controller-realtime.sql.
--
-- broadcast_course_table_change_unified only fans out to per-student channels for
-- the tables named in its student-facing branch; class_sections is not one of
-- them, so this is one staff-channel message per changed row, not one per
-- student. sis_sync_enrollment only writes rows that actually changed (see
-- 20260224140000_calendar_events_broadcast_real_change_filter.sql), so the hourly
-- sync does not turn this into a broadcast storm.
DROP TRIGGER IF EXISTS broadcast_class_sections_realtime ON public.class_sections;
CREATE TRIGGER broadcast_class_sections_realtime
  AFTER INSERT OR DELETE OR UPDATE
  ON public.class_sections
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_course_table_change_unified();
