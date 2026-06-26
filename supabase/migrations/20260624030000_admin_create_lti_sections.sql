-- Auto-create Pawtograder sections from a Canvas context's section names, and
-- map each name to the created (or reused) section. Admin-only.
--
-- Section type is derived from the context's section_role (lecture -> class
-- sections, lab -> lab sections). Canvas sections frequently carry no SIS id,
-- but the roster sync matches sections by `sis_crn`, so we synthesize a stable,
-- unique CRN per new section in a high range (>= 990000000) so it is visibly
-- non-registrar and won't collide with real CRNs on the class.
CREATE OR REPLACE FUNCTION public.admin_create_lti_sections_from_canvas(
    p_context_link_id bigint,
    p_section_names text[],
    p_created_by uuid DEFAULT auth.uid()
)
RETURNS TABLE (
    canvas_section_name text,
    section_id bigint,
    section_type text,
    sis_crn integer,
    created boolean
) AS $$
DECLARE
    v_class_id bigint;
    v_section_role text;
    v_type text;            -- 'class' | 'lab'
    v_name text;
    v_trimmed text;
    v_existing_id bigint;
    v_new_id bigint;
    v_crn integer;
    v_next_crn integer;
    v_created boolean;
BEGIN
    SET LOCAL search_path = pg_catalog, public;

    -- Authorize the actual caller (auth.uid()), never a caller-supplied UUID:
    -- this function is SECURITY DEFINER and granted to `authenticated`, so a
    -- parameter-based check would let any logged-in user pass an admin's UUID
    -- and escalate. Bind p_created_by to the caller so audit can't be spoofed.
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;
    p_created_by := auth.uid();

    SELECT l.class_id, l.section_role
      INTO v_class_id, v_section_role
      FROM public.lti_context_links l
     WHERE l.id = p_context_link_id;
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Context link % is not bound to a class', p_context_link_id;
    END IF;

    v_type := CASE v_section_role WHEN 'lab' THEN 'lab' WHEN 'lecture' THEN 'class' ELSE NULL END;
    IF v_type IS NULL THEN
        RAISE EXCEPTION 'Set the context section role to lecture or lab before auto-creating sections';
    END IF;

    -- Synthesized-CRN cursor: above any existing CRN on the class and above the
    -- synthetic floor. Incremented per newly created section below.
    SELECT GREATEST(COALESCE(MAX(s.c), 0), 990000000)
      INTO v_next_crn
      FROM (
        SELECT cs.sis_crn AS c FROM public.class_sections cs WHERE cs.class_id = v_class_id
        UNION ALL
        SELECT ls.sis_crn AS c FROM public.lab_sections ls WHERE ls.class_id = v_class_id
      ) s;

    FOREACH v_name IN ARRAY p_section_names LOOP
        v_trimmed := trim(v_name);
        CONTINUE WHEN v_trimmed IS NULL OR v_trimmed = '';
        v_existing_id := NULL; v_new_id := NULL; v_crn := NULL; v_created := false;

        -- Reuse an existing same-name section of the right type if present.
        IF v_type = 'class' THEN
            SELECT cs.id, cs.sis_crn INTO v_existing_id, v_crn
              FROM public.class_sections cs
             WHERE cs.class_id = v_class_id AND lower(cs.name) = lower(v_trimmed)
             LIMIT 1;
        ELSE
            SELECT ls.id, ls.sis_crn INTO v_existing_id, v_crn
              FROM public.lab_sections ls
             WHERE ls.class_id = v_class_id AND lower(ls.name) = lower(v_trimmed)
             LIMIT 1;
        END IF;

        IF v_existing_id IS NULL THEN
            v_next_crn := v_next_crn + 1;
            v_crn := v_next_crn;
            v_created := true;
            IF v_type = 'class' THEN
                v_new_id := public.admin_create_class_section(v_class_id, v_trimmed, p_created_by, NULL, NULL, NULL, v_crn);
            ELSE
                v_new_id := public.admin_create_lab_section(v_class_id, v_trimmed, p_created_by, NULL, NULL, NULL, v_crn);
            END IF;
        ELSE
            v_new_id := v_existing_id;
        END IF;

        -- Map the Canvas section name -> section (idempotent on re-run). Done as
        -- an explicit upsert with a table alias because ON CONFLICT targets
        -- can't be table-qualified and collide with the OUT column names.
        IF EXISTS (
            SELECT 1 FROM public.lti_context_section_map m
             WHERE m.context_link_id = p_context_link_id AND m.canvas_section_name = v_trimmed
        ) THEN
            UPDATE public.lti_context_section_map m
               SET class_section_id = CASE WHEN v_type = 'class' THEN v_new_id END,
                   lab_section_id   = CASE WHEN v_type = 'lab' THEN v_new_id END
             WHERE m.context_link_id = p_context_link_id AND m.canvas_section_name = v_trimmed;
        ELSE
            INSERT INTO public.lti_context_section_map (context_link_id, canvas_section_name, class_section_id, lab_section_id)
            VALUES (
                p_context_link_id,
                v_trimmed,
                CASE WHEN v_type = 'class' THEN v_new_id END,
                CASE WHEN v_type = 'lab' THEN v_new_id END
            );
        END IF;

        canvas_section_name := v_trimmed;
        section_id := v_new_id;
        section_type := v_type;
        sis_crn := v_crn;
        created := v_created;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.admin_create_lti_sections_from_canvas(bigint, text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_lti_sections_from_canvas(bigint, text[], uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_create_lti_sections_from_canvas IS
    'Admin-only: create/reuse Pawtograder sections from Canvas section names and map them on the LTI context. Section type from section_role; synthesizes CRNs for sections that need them.';
