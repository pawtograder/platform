-- LTI Section Mapping & Provisioning Governance (Phase 1)
--
-- Companion to docs/lti-section-mapping.md. Builds on 20260528120000_lti_1_3_integration.
--
-- Adds the data model + governance for mapping Canvas (LMS) courses/sections onto
-- Pawtograder classes and lecture/lab sections, so the LTI roster sync can enroll
-- students into the correct sections instead of course-wide:
--
--   * lti_context_links gains a section role + section targets (topology A) and a
--     split-by-member flag (topology B).
--   * lti_context_section_map: per-context Canvas-section-name -> Pawtograder section
--     (topology B).
--   * Governance: only site admins may bind a context to a class (admin_bind_lti_context);
--     instructors self-serve *section mapping only* via an extended column-level UPDATE
--     grant that deliberately excludes class_id (and the SSRF-sensitive service URLs).
--   * admin_list_lti_contexts: admin-facing joined list incl. unbound contexts.
--
-- Section resolution in the RPC (public.sis_sync_enrollment) matches by sis_crn, so a
-- Pawtograder section is only mappable if it has a non-null sis_crn.

-------------------------------------------------------------------------------
-- 1. lti_context_links: section role + targets (docs §3.1)
-------------------------------------------------------------------------------
ALTER TABLE public.lti_context_links
  ADD COLUMN IF NOT EXISTS section_role text NOT NULL DEFAULT 'course_wide'
    CHECK (section_role IN ('lecture', 'lab', 'course_wide')),
  ADD COLUMN IF NOT EXISTS class_section_id bigint REFERENCES public.class_sections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lab_section_id  bigint REFERENCES public.lab_sections(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS split_by_member_section boolean NOT NULL DEFAULT false;

-- Governance: let instructors self-serve section mapping, but NOT rebind the class
-- or repoint service URLs. Column-level privileges are the enforcement: an UPDATE
-- that touches any non-granted column (e.g. class_id, nrps_url) is rejected for
-- `authenticated`. The existing GRANT covers (roster_sync_enabled, grade_sync_enabled).
GRANT UPDATE (section_role, class_section_id, lab_section_id, split_by_member_section)
  ON TABLE public.lti_context_links TO authenticated;

-------------------------------------------------------------------------------
-- 2. lti_context_section_map: Canvas section name -> Pawtograder section (docs §3.2)
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lti_context_section_map (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context_link_id bigint NOT NULL REFERENCES public.lti_context_links(id) ON DELETE CASCADE,
  canvas_section_name text NOT NULL,            -- value seen in $com.instructure.User.sectionNames
  class_section_id bigint REFERENCES public.class_sections(id) ON DELETE CASCADE,
  lab_section_id  bigint REFERENCES public.lab_sections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_link_id, canvas_section_name),
  CHECK (num_nonnulls(class_section_id, lab_section_id) = 1)
);

ALTER TABLE public.lti_context_section_map ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lti_context_section_map TO authenticated;
GRANT ALL ON TABLE public.lti_context_section_map TO service_role;

-- Instructors may CRUD map rows for contexts bound to a class they instruct. The
-- class is resolved through the parent context link, so an instructor cannot forge
-- a row against a context that isn't theirs.
CREATE POLICY "Instructors manage section map" ON public.lti_context_section_map
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.lti_context_links l
      WHERE l.id = context_link_id AND l.class_id IS NOT NULL
        AND public.authorizeforclassinstructor(l.class_id)
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.lti_context_links l
      WHERE l.id = context_link_id AND l.class_id IS NOT NULL
        AND public.authorizeforclassinstructor(l.class_id)
    )
  );
CREATE POLICY "Admins manage section map" ON public.lti_context_section_map
  FOR ALL USING (public.authorize_for_admin()) WITH CHECK (public.authorize_for_admin());
CREATE POLICY "Service role manages section map" ON public.lti_context_section_map
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS lti_context_section_map_context_link_id_idx
  ON public.lti_context_section_map (context_link_id);

-------------------------------------------------------------------------------
-- 3. admin_bind_lti_context: the ONLY supported class_id setter (docs §3.4, §7.1)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_bind_lti_context(
  p_context_link_id bigint,
  p_class_id bigint DEFAULT NULL,    -- omit / NULL to unbind
  p_section_role text DEFAULT NULL   -- optional initial designation
)
RETURNS public.lti_context_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
  v_row public.lti_context_links;
BEGIN
  IF NOT public.authorize_for_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;
  IF p_section_role IS NOT NULL AND p_section_role NOT IN ('lecture', 'lab', 'course_wide') THEN
    RAISE EXCEPTION 'Invalid section_role: %', p_section_role;
  END IF;

  UPDATE public.lti_context_links
    SET class_id = p_class_id,
        section_role = COALESCE(p_section_role, section_role),
        updated_at = now()
  WHERE id = p_context_link_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Context link % not found', p_context_link_id;
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_bind_lti_context(bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_bind_lti_context(bigint, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_bind_lti_context(bigint, bigint, text) TO service_role;

-------------------------------------------------------------------------------
-- 4. admin_list_lti_contexts: admin-facing list incl. unbound contexts (docs §5.2)
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_lti_contexts()
RETURNS TABLE (
  id bigint,
  platform_id bigint,
  platform_name text,
  context_id text,
  context_label text,
  context_title text,
  class_id bigint,
  class_name text,
  section_role text,
  class_section_id bigint,
  lab_section_id bigint,
  split_by_member_section boolean,
  roster_sync_enabled boolean,
  grade_sync_enabled boolean,
  last_roster_sync_at timestamptz,
  last_roster_sync_status text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
  IF NOT public.authorize_for_admin() THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;
  RETURN QUERY
  SELECT l.id, l.platform_id, p.name, l.context_id, l.context_label, l.context_title,
         l.class_id, c.name, l.section_role, l.class_section_id, l.lab_section_id,
         l.split_by_member_section, l.roster_sync_enabled, l.grade_sync_enabled,
         l.last_roster_sync_at, l.last_roster_sync_status
  FROM public.lti_context_links l
  JOIN public.lti_platforms p ON p.id = l.platform_id
  LEFT JOIN public.classes c ON c.id = l.class_id
  ORDER BY p.name, l.context_title NULLS LAST, l.id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_lti_contexts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_lti_contexts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_lti_contexts() TO service_role;
