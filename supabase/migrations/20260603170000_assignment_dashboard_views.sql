-- Migration: per-assignment instructor dashboard views (saved, shared report config).
--
-- One row per assignment holds the SHARED default rubric-report view (filter AST + chosen
-- visualization). Instructors edit it; all staff see it. This is also how spec-grading
-- "mastery" breakdowns are expressed: an instructor saves an option-based view as the default.
--
-- Authorization is inlined against user_privileges (no authorizeforclass* helper). The config
-- is validated by a trigger that reuses the injection-safe _validate_rubric_report_filter, so a
-- stored filter can never be anything but the closed predicate set.

CREATE TABLE IF NOT EXISTS public.assignment_dashboard_views (
  assignment_id bigint PRIMARY KEY REFERENCES public.assignments (id) ON DELETE CASCADE,
  class_id bigint NOT NULL REFERENCES public.classes (id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles (id)
);

ALTER TABLE public.assignment_dashboard_views ENABLE ROW LEVEL SECURITY;

-- Staff (instructor or grader) of the class may read the shared view.
CREATE POLICY "dashboard_views_staff_select" ON public.assignment_dashboard_views
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.class_id = assignment_dashboard_views.class_id
        AND up.user_id = auth.uid()
        AND up.role IN ('instructor'::public.app_role, 'grader'::public.app_role)
    )
  );

-- Only instructors may create/update/delete the shared view.
CREATE POLICY "dashboard_views_instructor_write" ON public.assignment_dashboard_views
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.class_id = assignment_dashboard_views.class_id
        AND up.user_id = auth.uid()
        AND up.role = 'instructor'::public.app_role
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.class_id = assignment_dashboard_views.class_id
        AND up.user_id = auth.uid()
        AND up.role = 'instructor'::public.app_role
    )
  );

-- Validate config shape + provenance on write. SECURITY DEFINER so it can resolve the
-- assignment's class and the caller's profile regardless of RLS.
CREATE OR REPLACE FUNCTION public._validate_assignment_dashboard_view()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_viz text;
BEGIN
  SELECT a.class_id INTO v_class_id FROM public.assignments a WHERE a.id = NEW.assignment_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Assignment % does not exist', NEW.assignment_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  NEW.class_id := v_class_id;

  IF jsonb_typeof(NEW.config) <> 'object' THEN
    RAISE EXCEPTION 'Dashboard view config must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_viz := NEW.config ->> 'viz';
  IF v_viz IS NULL OR v_viz NOT IN ('bars', 'options', 'table', 'section') THEN
    RAISE EXCEPTION 'Invalid dashboard view: viz must be one of bars/options/table/section' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A stored filter must pass the same closed-predicate validation used by the report RPC.
  IF (NEW.config ? 'filter') AND jsonb_typeof(NEW.config -> 'filter') IS DISTINCT FROM 'null' THEN
    PERFORM public._validate_rubric_report_filter(NEW.config -> 'filter', 0);
  END IF;

  NEW.updated_at := now();
  SELECT up.private_profile_id INTO NEW.updated_by
  FROM public.user_privileges up
  WHERE up.class_id = v_class_id AND up.user_id = auth.uid()
  LIMIT 1;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_assignment_dashboard_view
  BEFORE INSERT OR UPDATE ON public.assignment_dashboard_views
  FOR EACH ROW EXECUTE FUNCTION public._validate_assignment_dashboard_view();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_dashboard_views TO authenticated;

COMMENT ON TABLE public.assignment_dashboard_views IS
'Per-assignment SHARED instructor dashboard view (rubric-report filter AST + visualization). One row per assignment; readable by staff, writable by instructors. config is validated by trigger (viz enum + injection-safe filter validation).';
