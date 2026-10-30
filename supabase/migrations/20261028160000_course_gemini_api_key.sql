-- #1126: one course-owned Gemini API key per class, stored in Supabase Vault.
--
-- Storage: the key lives only in vault.secrets. course_secrets.course_gemini_api_keys maps a class
-- to the Vault secret it owns. The course_secrets schema is not exposed through PostgREST
-- (config.toml api.schemas), and no client role has USAGE on it, so the mapping and secret ids are
-- unreachable from the browser even if a table grant regressed.
--
-- Management: three SECURITY DEFINER RPCs, executable by authenticated users and gated on active
-- instructor membership of the requested class (authorizeforclassinstructor, backed by
-- user_privileges, which excludes disabled roles). There is deliberately no RPC that returns the
-- key: responses carry only {setup_enabled, configured, outcome}. Errors use fixed messages with no
-- DETAIL/HINT so no input, secret name or secret id can be echoed to the client.
--
-- Setup flag: the course feature "gemini-api-key-setup" (classes.features, toggled through
-- merge_class_feature) must be an explicit JSON true to save or replace a key. Absent, false or
-- malformed means disabled. Status and removal ignore the flag.
--
-- Concurrency: mutators take the classes row FOR NO KEY UPDATE before reading the mapping. That
-- serializes them with each other (including two first saves, before any mapping row exists), with
-- merge_class_feature (FOR UPDATE) and with DELETE FROM classes, without blocking FK inserts
-- elsewhere (FOR KEY SHARE). The course's Vault secret is only written under that lock (by these
-- RPCs, or by the cleanup trigger during DELETE FROM classes, which conflicts with it), so the Vault
-- row itself is not locked; postgres has no UPDATE privilege on vault.secrets, which row locks need.
--
-- Lifecycle: an AFTER DELETE trigger on the mapping deletes the owned Vault secret, both for explicit
-- removal and for the ON DELETE CASCADE from classes. A failure there aborts the whole statement, so a
-- course deletion that cannot clean up its secret does not happen. Archiving (classes.archived)
-- touches neither row.
--
-- Nothing here calls Google or validates the key; "configured" only means a key is stored.

DO $vault_guard$
BEGIN
  -- Fail the migration (instead of deploying a design that cannot clean up) when the migrating role
  -- lacks the Vault privileges the functions below rely on.
  IF NOT has_function_privilege(current_user, 'vault.create_secret(text, text, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege(current_user, 'vault.update_secret(uuid, text, text, text, uuid)', 'EXECUTE')
     OR NOT has_table_privilege(current_user, 'vault.secrets', 'SELECT')
     OR NOT has_table_privilege(current_user, 'vault.secrets', 'DELETE')
     OR NOT has_table_privilege(current_user, 'vault.decrypted_secrets', 'SELECT') THEN
    RAISE EXCEPTION 'course Gemini key storage requires Vault create/update/delete privileges for %', current_user;
  END IF;
END
$vault_guard$;

CREATE SCHEMA course_secrets;
COMMENT ON SCHEMA course_secrets IS
  'Private (non-API) storage for course-owned credentials. No client role has USAGE. See 20261028160000_course_gemini_api_key.sql.';
REVOKE ALL ON SCHEMA course_secrets FROM PUBLIC;
REVOKE ALL ON SCHEMA course_secrets FROM anon, authenticated, service_role;

CREATE TABLE course_secrets.course_gemini_api_keys (
  class_id bigint PRIMARY KEY REFERENCES public.classes(id) ON DELETE CASCADE,
  vault_secret_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE course_secrets.course_gemini_api_keys IS
  'Maps a class to the Vault secret holding its Gemini API key. At most one per class. Deleting a row deletes the owned Vault secret (trigger).';
ALTER TABLE course_secrets.course_gemini_api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE course_secrets.course_gemini_api_keys FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (no client EXECUTE)
-- ---------------------------------------------------------------------------------------------

-- Strict flag reader, modeled on discord_student_join_enabled: only a JSON boolean counts, anything
-- else (absent entry, "true" string, non-array features) is disabled.
CREATE FUNCTION course_secrets.gemini_key_setup_enabled(p_class_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT CASE WHEN jsonb_typeof(f -> 'enabled') = 'boolean' THEN (f -> 'enabled')::boolean END
      FROM public.classes c,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.features) = 'array' THEN c.features ELSE '[]'::jsonb END
           ) AS f
      WHERE c.id = p_class_id
        AND f ->> 'name' = 'gemini-api-key-setup'
      LIMIT 1
    ),
    false
  );
$$;
REVOKE ALL ON FUNCTION course_secrets.gemini_key_setup_enabled(bigint) FROM PUBLIC, anon, authenticated, service_role;

-- Configured means the mapping exists AND its Vault secret exists; a dangling mapping is not
-- reported as configured.
CREATE FUNCTION course_secrets.gemini_key_configured(p_class_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM course_secrets.course_gemini_api_keys m
    JOIN vault.secrets s ON s.id = m.vault_secret_id
    WHERE m.class_id = p_class_id
  );
$$;
REVOKE ALL ON FUNCTION course_secrets.gemini_key_configured(bigint) FROM PUBLIC, anon, authenticated, service_role;

-- Owned-secret cleanup for explicit removal and for the cascade from classes.
CREATE FUNCTION course_secrets.delete_owned_vault_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.vault_secret_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION course_secrets.delete_owned_vault_secret() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER course_gemini_api_keys_delete_vault_secret
AFTER DELETE ON course_secrets.course_gemini_api_keys
FOR EACH ROW EXECUTE FUNCTION course_secrets.delete_owned_vault_secret();

-- A mapping row never switches class or secret; replacement updates the secret in place.
CREATE FUNCTION course_secrets.forbid_mapping_rekey()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.class_id IS DISTINCT FROM OLD.class_id OR NEW.vault_secret_id IS DISTINCT FROM OLD.vault_secret_id THEN
    RAISE EXCEPTION 'course_gemini_api_keys rows cannot change class or secret';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION course_secrets.forbid_mapping_rekey() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER course_gemini_api_keys_forbid_rekey
BEFORE UPDATE ON course_secrets.course_gemini_api_keys
FOR EACH ROW EXECUTE FUNCTION course_secrets.forbid_mapping_rekey();

-- TRUNCATE (directly, or TRUNCATE classes CASCADE) skips row triggers and would orphan secrets.
CREATE FUNCTION course_secrets.forbid_mapping_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'course_gemini_api_keys cannot be truncated; delete rows so their Vault secrets are removed';
END;
$$;
REVOKE ALL ON FUNCTION course_secrets.forbid_mapping_truncate() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER course_gemini_api_keys_forbid_truncate
BEFORE TRUNCATE ON course_secrets.course_gemini_api_keys
FOR EACH STATEMENT EXECUTE FUNCTION course_secrets.forbid_mapping_truncate();

-- ---------------------------------------------------------------------------------------------
-- Instructor RPCs
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.get_course_gemini_key_status(p_class_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_class_id IS NULL OR NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'setup_enabled', course_secrets.gemini_key_setup_enabled(p_class_id),
    'configured', course_secrets.gemini_key_configured(p_class_id)
  );
END;
$$;

COMMENT ON FUNCTION public.get_course_gemini_key_status(bigint) IS
  'Active instructors: whether Gemini key setup is enabled and whether a key is stored for the course. Never returns key material or ids.';

REVOKE ALL ON FUNCTION public.get_course_gemini_key_status(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_course_gemini_key_status(bigint) TO authenticated, service_role;

CREATE FUNCTION public.set_course_gemini_key(p_class_id bigint, p_api_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
AS $$
DECLARE
  v_key text;
  v_secret_id uuid;
  v_outcome text;
BEGIN
  IF auth.uid() IS NULL OR p_class_id IS NULL OR NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  -- Trim surrounding whitespace, including Unicode spaces and zero-width characters, and store the
  -- trimmed value. No provider-format validation.
  v_key := regexp_replace(
    COALESCE(p_api_key, ''),
    '^[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+|[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    '',
    'g'
  );
  IF v_key = '' THEN
    RAISE EXCEPTION 'API key is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_key) > 4096 THEN
    RAISE EXCEPTION 'API key is too long' USING ERRCODE = '22023';
  END IF;

  BEGIN
    PERFORM 1 FROM public.classes WHERE id = p_class_id FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT public.authorizeforclassinstructor(p_class_id) THEN
      RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    END IF;

    IF NOT course_secrets.gemini_key_setup_enabled(p_class_id) THEN
      RAISE EXCEPTION 'Gemini API key setup is disabled for this course' USING ERRCODE = '55000';
    END IF;

    SELECT m.vault_secret_id INTO v_secret_id
    FROM course_secrets.course_gemini_api_keys m
    WHERE m.class_id = p_class_id;

    IF v_secret_id IS NOT NULL THEN
      PERFORM 1 FROM vault.secrets s WHERE s.id = v_secret_id;
      IF FOUND THEN
        -- Replace in place: the secret id stays stable, so no second secret is ever created.
        -- vault.update_secret silently does nothing for an unknown id, so confirm the stored value.
        PERFORM vault.update_secret(v_secret_id, v_key);
        IF NOT EXISTS (
          SELECT 1 FROM vault.decrypted_secrets d WHERE d.id = v_secret_id AND d.decrypted_secret = v_key
        ) THEN
          RAISE EXCEPTION 'vault secret update did not apply';
        END IF;
        UPDATE course_secrets.course_gemini_api_keys SET updated_at = now() WHERE class_id = p_class_id;
        v_outcome := 'replaced';
      ELSE
        -- Dangling mapping (its secret is gone): drop it and store the key as a first save.
        DELETE FROM course_secrets.course_gemini_api_keys WHERE class_id = p_class_id;
        v_secret_id := NULL;
      END IF;
    END IF;

    IF v_secret_id IS NULL THEN
      v_secret_id := vault.create_secret(
        v_key,
        'course_gemini_api_key:' || p_class_id::text,
        'Course-owned Gemini API key (#1126)'
      );
      INSERT INTO course_secrets.course_gemini_api_keys (class_id, vault_secret_id)
      VALUES (p_class_id, v_secret_id);
      v_outcome := 'saved';
    END IF;
  EXCEPTION
    -- lock_not_available (55P03) must come before object_not_in_prerequisite_state: the latter is
    -- the class-55 condition in PL/pgSQL and would otherwise also catch lock timeouts.
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'The course is busy; try again' USING ERRCODE = '55P03';
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    WHEN object_not_in_prerequisite_state THEN
      RAISE EXCEPTION 'Gemini API key setup is disabled for this course' USING ERRCODE = '55000';
    WHEN OTHERS THEN
      RAISE LOG 'set_course_gemini_key failed for class %: sqlstate %', p_class_id, SQLSTATE;
      RAISE EXCEPTION 'Credential operation failed' USING ERRCODE = 'XX000';
  END;

  RETURN jsonb_build_object('setup_enabled', true, 'configured', true, 'outcome', v_outcome);
END;
$$;

COMMENT ON FUNCTION public.set_course_gemini_key(bigint, text) IS
  'Active instructors: save or replace the course Gemini API key in Vault. Requires the gemini-api-key-setup course feature. Does not validate the key.';

REVOKE ALL ON FUNCTION public.set_course_gemini_key(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_course_gemini_key(bigint, text) TO authenticated, service_role;

CREATE FUNCTION public.remove_course_gemini_key(p_class_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
AS $$
DECLARE
  v_outcome text;
BEGIN
  IF auth.uid() IS NULL OR p_class_id IS NULL OR NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM 1 FROM public.classes WHERE id = p_class_id FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT public.authorizeforclassinstructor(p_class_id) THEN
      RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    END IF;

    -- The AFTER DELETE trigger removes the owned Vault secret in this transaction.
    DELETE FROM course_secrets.course_gemini_api_keys WHERE class_id = p_class_id;
    v_outcome := CASE WHEN FOUND THEN 'removed' ELSE 'already_absent' END;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'The course is busy; try again' USING ERRCODE = '55P03';
    WHEN OTHERS THEN
      RAISE LOG 'remove_course_gemini_key failed for class %: sqlstate %', p_class_id, SQLSTATE;
      RAISE EXCEPTION 'Credential operation failed' USING ERRCODE = 'XX000';
  END;

  RETURN jsonb_build_object(
    'setup_enabled', course_secrets.gemini_key_setup_enabled(p_class_id),
    'configured', false,
    'outcome', v_outcome
  );
END;
$$;

COMMENT ON FUNCTION public.remove_course_gemini_key(bigint) IS
  'Active instructors: remove the course Gemini API key and its Vault secret. Allowed whether or not setup is enabled. Succeeds when no key is stored.';

REVOKE ALL ON FUNCTION public.remove_course_gemini_key(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_course_gemini_key(bigint) TO authenticated, service_role;
