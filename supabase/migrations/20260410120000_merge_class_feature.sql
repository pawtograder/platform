-- Instructor-only RPC to merge one entry into classes.features (jsonb array of {name, enabled}).
-- RLS otherwise prevents updating classes.features (only calendar/discord columns are allowed).
-- Row lock + normalized names; service_role-only RPC for E2E (merge_class_feature requires instructor JWT).

CREATE OR REPLACE FUNCTION public.merge_class_feature(
  p_class_id bigint,
  p_name text,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_name text;
  v_features jsonb;
  v_arr jsonb;
  v_new jsonb := '[]'::jsonb;
  elem jsonb;
  -- Do NOT name this "found" — that shadows the PL/pgSQL automatic FOUND
  -- variable, causing SELECT INTO to silently fail to update it.
  feature_found boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_name IS NULL THEN
    RAISE EXCEPTION 'Feature name is required';
  END IF;

  v_name := btrim(p_name);
  IF v_name = '' THEN
    RAISE EXCEPTION 'Feature name is required';
  END IF;

  IF NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', p_class_id;
  END IF;

  SELECT features INTO v_features FROM public.classes
  WHERE id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class not found';
  END IF;

  IF v_features IS NULL OR jsonb_typeof(v_features) <> 'array' THEN
    v_arr := '[]'::jsonb;
  ELSE
    v_arr := v_features;
  END IF;

  FOR elem IN
    SELECT * FROM jsonb_array_elements(v_arr)
  LOOP
    IF (elem->>'name') = v_name THEN
      v_new := v_new || jsonb_build_array(jsonb_build_object('name', v_name, 'enabled', p_enabled));
      feature_found := true;
    ELSE
      v_new := v_new || jsonb_build_array(elem);
    END IF;
  END LOOP;

  IF NOT feature_found THEN
    v_new := v_new || jsonb_build_array(jsonb_build_object('name', v_name, 'enabled', p_enabled));
  END IF;

  UPDATE public.classes
  SET features = v_new
  WHERE id = p_class_id;
END;
$$;

COMMENT ON FUNCTION public.merge_class_feature(bigint, text, boolean) IS
  'Instructors: upsert one course feature flag in classes.features (array of {name, enabled}).';

REVOKE ALL ON FUNCTION public.merge_class_feature(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_class_feature(bigint, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.merge_class_feature_as_service_role(
  p_class_id bigint,
  p_name text,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_name text;
  v_features jsonb;
  v_arr jsonb;
  v_new jsonb := '[]'::jsonb;
  elem jsonb;
  feature_found boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'merge_class_feature_as_service_role: service_role only';
  END IF;

  IF p_name IS NULL THEN
    RAISE EXCEPTION 'Feature name is required';
  END IF;

  v_name := btrim(p_name);
  IF v_name = '' THEN
    RAISE EXCEPTION 'Feature name is required';
  END IF;

  SELECT features INTO v_features
  FROM public.classes
  WHERE id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class not found';
  END IF;

  IF v_features IS NULL OR jsonb_typeof(v_features) <> 'array' THEN
    v_arr := '[]'::jsonb;
  ELSE
    v_arr := v_features;
  END IF;

  FOR elem IN
    SELECT * FROM jsonb_array_elements(v_arr)
  LOOP
    IF (elem->>'name') = v_name THEN
      v_new := v_new || jsonb_build_array(jsonb_build_object('name', v_name, 'enabled', p_enabled));
      feature_found := true;
    ELSE
      v_new := v_new || jsonb_build_array(elem);
    END IF;
  END LOOP;

  IF NOT feature_found THEN
    v_new := v_new || jsonb_build_array(jsonb_build_object('name', v_name, 'enabled', p_enabled));
  END IF;

  UPDATE public.classes
  SET features = v_new
  WHERE id = p_class_id;
END;
$$;

COMMENT ON FUNCTION public.merge_class_feature_as_service_role(bigint, text, boolean) IS
  'Service role only: same merge as merge_class_feature for tests and automation (no instructor JWT).';

REVOKE ALL ON FUNCTION public.merge_class_feature_as_service_role(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_class_feature_as_service_role(bigint, text, boolean) TO service_role;

-- Opt-in default: persist explicit gradebook-what-if disabled for all existing classes (visibility in DB / exports).
DO $$
DECLARE
  r record;
  v_features jsonb;
  v_arr jsonb;
  v_new jsonb;
  elem jsonb;
  found boolean;
BEGIN
  FOR r IN SELECT id, features FROM public.classes LOOP
    v_features := r.features;
    IF v_features IS NULL OR jsonb_typeof(v_features) <> 'array' THEN
      v_arr := '[]'::jsonb;
    ELSE
      v_arr := v_features;
    END IF;
    v_new := '[]'::jsonb;
    found := false;
    FOR elem IN
      SELECT * FROM jsonb_array_elements(v_arr)
    LOOP
      IF (elem->>'name') = 'gradebook-what-if' THEN
        v_new := v_new || jsonb_build_array(jsonb_build_object('name', 'gradebook-what-if', 'enabled', false));
        found := true;
      ELSE
        v_new := v_new || jsonb_build_array(elem);
      END IF;
    END LOOP;
    IF NOT found THEN
      v_new := v_new || jsonb_build_array(jsonb_build_object('name', 'gradebook-what-if', 'enabled', false));
    END IF;
    UPDATE public.classes SET features = v_new WHERE id = r.id;
  END LOOP;
END $$;
