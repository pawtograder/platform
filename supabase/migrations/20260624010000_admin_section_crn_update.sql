-- Let admins edit a section's SIS CRN (not just its name).
--
-- The LTI section mapping (docs/lti-section-mapping.md) resolves Canvas sections
-- to Pawtograder sections by `sis_crn`, so admins need a way to set/correct CRNs.
-- The existing admin_update_{class,lab}_section only updated `name`; add p_sis_crn.
-- Adding a parameter changes the signature, so DROP the old 3-arg form first.
-- (Sole caller is app/admin/classes/SectionManagementModal.tsx.)

DROP FUNCTION IF EXISTS public.admin_update_class_section(bigint, text, uuid);
DROP FUNCTION IF EXISTS public.admin_update_lab_section(bigint, text, uuid);

CREATE OR REPLACE FUNCTION public.admin_update_class_section(
    p_section_id bigint,
    p_name text,
    p_updated_by uuid DEFAULT auth.uid(),
    p_sis_crn integer DEFAULT NULL
)
RETURNS boolean AS $$
BEGIN
    SET LOCAL search_path = pg_catalog, public;

    IF NOT authorize_for_admin(p_updated_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    UPDATE public.class_sections SET
        name = trim(p_name),
        sis_crn = p_sis_crn,
        updated_at = now()
    WHERE id = p_section_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_update_lab_section(
    p_section_id bigint,
    p_name text,
    p_updated_by uuid DEFAULT auth.uid(),
    p_sis_crn integer DEFAULT NULL
)
RETURNS boolean AS $$
BEGIN
    SET LOCAL search_path = pg_catalog, public;

    IF NOT authorize_for_admin(p_updated_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    UPDATE public.lab_sections SET
        name = trim(p_name),
        sis_crn = p_sis_crn,
        updated_at = now()
    WHERE id = p_section_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
