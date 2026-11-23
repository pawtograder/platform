-- #1010: managing lab sections follows the new manage_roster capability.
--
-- Why: creating, changing and deleting lab sections, their meetings and their leaders needed an
-- instructor, so no TA role could be given them. Now one capability decides, in the database and on
-- the screen, and an instructor can turn it on for a custom role such as a Head TA. Later
-- migrations in this PR move class section renames and student enrollments to it too.
--
-- What:
--   1. New capability manage_roster, on the default instructor role of every class. It isn't on the
--      default grader role or on custom roles: graders couldn't manage lab sections before, so no
--      one gains or loses access.
--   2. The FOR ALL instructor policies on lab_sections, lab_section_meetings and
--      lab_section_leaders become INSERT, UPDATE and DELETE policies on manage_roster. The SELECT
--      policies (anyone in the class reads) are unchanged.
--   3. Same-class checks, for everyone: a meeting's lab section must be in the meeting's class, and
--      a leader's profile must be in the leader row's class. Before, an instructor could attach a
--      meeting to another class's lab section, or make someone from another class a leader.
--      (sync_lab_section_leaders_class_id already sets a leader row's class from its lab section.)
--
-- Safe to run again: every policy is dropped before it is created, and the inserts skip rows that
-- exist.

-- ---------------------------------------------------------------------------
-- 1. The capability, on every default instructor role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('manage_roster', 'Manage lab sections, rename class sections, and add, remove and invite students')
ON CONFLICT (name) DO NOTHING;

-- New classes get it from seed_default_class_roles(), which gives the instructor role every
-- capability. Existing classes need it added here.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_roster'
FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. lab_sections
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors_manage_lab_sections" ON public.lab_sections;
DROP POLICY IF EXISTS "Roster managers can create lab_sections" ON public.lab_sections;
DROP POLICY IF EXISTS "Roster managers can update lab_sections" ON public.lab_sections;
DROP POLICY IF EXISTS "Roster managers can delete lab_sections" ON public.lab_sections;

CREATE POLICY "Roster managers can create lab_sections" ON public.lab_sections
  FOR INSERT TO authenticated
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')));

CREATE POLICY "Roster managers can update lab_sections" ON public.lab_sections
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')));

CREATE POLICY "Roster managers can delete lab_sections" ON public.lab_sections
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')));

-- ---------------------------------------------------------------------------
-- 3. lab_section_meetings: the lab section must be in the meeting's class
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors_manage_lab_meetings" ON public.lab_section_meetings;
DROP POLICY IF EXISTS "Roster managers can create lab_section_meetings" ON public.lab_section_meetings;
DROP POLICY IF EXISTS "Roster managers can update lab_section_meetings" ON public.lab_section_meetings;
DROP POLICY IF EXISTS "Roster managers can delete lab_section_meetings" ON public.lab_section_meetings;

CREATE POLICY "Roster managers can create lab_section_meetings" ON public.lab_section_meetings
  FOR INSERT TO authenticated
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_roster'))
    AND lab_section_id IN (
      SELECT ls.id FROM public.lab_sections ls WHERE ls.class_id = lab_section_meetings.class_id
    )
  );

CREATE POLICY "Roster managers can update lab_section_meetings" ON public.lab_section_meetings
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')))
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_roster'))
    AND lab_section_id IN (
      SELECT ls.id FROM public.lab_sections ls WHERE ls.class_id = lab_section_meetings.class_id
    )
  );

CREATE POLICY "Roster managers can delete lab_section_meetings" ON public.lab_section_meetings
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')));

-- ---------------------------------------------------------------------------
-- 4. lab_section_leaders: the leader's profile must be in the row's class
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors_manage_lab_section_leaders" ON public.lab_section_leaders;
DROP POLICY IF EXISTS "Roster managers can create lab_section_leaders" ON public.lab_section_leaders;
DROP POLICY IF EXISTS "Roster managers can update lab_section_leaders" ON public.lab_section_leaders;
DROP POLICY IF EXISTS "Roster managers can delete lab_section_leaders" ON public.lab_section_leaders;

CREATE POLICY "Roster managers can create lab_section_leaders" ON public.lab_section_leaders
  FOR INSERT TO authenticated
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_roster'))
    AND profile_id IN (SELECT p.id FROM public.profiles p WHERE p.class_id = lab_section_leaders.class_id)
  );

CREATE POLICY "Roster managers can update lab_section_leaders" ON public.lab_section_leaders
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')))
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_roster'))
    AND profile_id IN (SELECT p.id FROM public.profiles p WHERE p.class_id = lab_section_leaders.class_id)
  );

CREATE POLICY "Roster managers can delete lab_section_leaders" ON public.lab_section_leaders
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')));
