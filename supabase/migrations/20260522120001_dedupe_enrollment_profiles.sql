-- #390 / #387: A student must have at most one enrollment (and therefore one
-- public+private profile pair) per class. Historically several code paths
-- (the invitation-accept trigger, create_user_role_for_existing_user, and the
-- auto-accept trigger's "create role" branch) could each mint a fresh profile
-- pair for the same (user, class), producing duplicate rows in the gradebook.
--
-- This migration:
--   1. Adds a partial unique index so a second *active* enrollment for the same
--      (user, class) can never be created again.
--   2. Provides merge_duplicate_class_enrollments() as an OPT-IN manual cleanup
--      tool: it collapses duplicate (user_id, class_id) enrollments onto a single
--      canonical row, repointing every profiles(id) foreign key from the losing
--      profiles to the canonical ones, then deleting the losing enrollments and
--      profiles. It is NOT run automatically -- existing records are left as-is.
--      Run `SELECT public.merge_duplicate_class_enrollments(<class_id>);` (or NULL
--      for all classes) by hand if duplicates ever need collapsing.
--
-- The function is idempotent: re-running it when no duplicates exist is a no-op.
-- Note: this only handles same-account (user_id, class_id) duplicates; duplicates
-- spread across two separate accounts for one person are not touched.

CREATE OR REPLACE FUNCTION public.merge_duplicate_class_enrollments(p_class_id bigint DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_merged integer := 0;
  grp RECORD;
  loser RECORD;
  fk RECORD;
  v_canon_role_id bigint;
  v_canon_private uuid;
  v_canon_public uuid;
  v_best_role public.app_role;
  v_any_active boolean;
BEGIN
  -- Discover every profiles(id) foreign key once (the catalog does not change
  -- mid-run), rather than re-querying information_schema for each losing row.
  DROP TABLE IF EXISTS tmp_profile_fks;
  CREATE TEMP TABLE tmp_profile_fks (table_schema text, table_name text, column_name text) ON COMMIT DROP;
  INSERT INTO tmp_profile_fks (table_schema, table_name, column_name)
  SELECT tc.table_schema, tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND ccu.table_schema = 'public'
    AND ccu.table_name = 'profiles'
    AND ccu.column_name = 'id'
    AND NOT (tc.table_schema = 'public' AND tc.table_name = 'user_roles');

  FOR grp IN
    SELECT ur.user_id, ur.class_id
    FROM public.user_roles ur
    WHERE p_class_id IS NULL OR ur.class_id = p_class_id
    GROUP BY ur.user_id, ur.class_id
    HAVING count(*) > 1
  LOOP
    -- Canonical row = the one whose private profile carries the most real data
    -- (submissions), preferring active rows, then the oldest row.
    SELECT ur.id, ur.private_profile_id, ur.public_profile_id
      INTO v_canon_role_id, v_canon_private, v_canon_public
    FROM public.user_roles ur
    WHERE ur.user_id = grp.user_id AND ur.class_id = grp.class_id
    ORDER BY
      (SELECT count(*) FROM public.submissions s WHERE s.profile_id = ur.private_profile_id) DESC,
      COALESCE(ur.disabled, false) ASC,
      ur.id ASC
    LIMIT 1;

    -- Strongest role and whether any duplicate was active: the survivor adopts both.
    SELECT
      (ARRAY_AGG(ur.role ORDER BY
        CASE ur.role WHEN 'instructor' THEN 3 WHEN 'grader' THEN 2 ELSE 1 END DESC))[1],
      bool_or(NOT COALESCE(ur.disabled, false))
      INTO v_best_role, v_any_active
    FROM public.user_roles ur
    WHERE ur.user_id = grp.user_id AND ur.class_id = grp.class_id;

    FOR loser IN
      SELECT ur.id, ur.private_profile_id, ur.public_profile_id
      FROM public.user_roles ur
      WHERE ur.user_id = grp.user_id AND ur.class_id = grp.class_id
        AND ur.id <> v_canon_role_id
    LOOP
      -- Repoint every profiles(id) foreign key (except user_roles itself, whose
      -- losing row we are about to delete) from the loser's profiles onto the
      -- canonical profiles. On a unique/FK collision the loser's row is redundant
      -- duplicate data, so we drop it instead.
      FOR fk IN SELECT table_schema, table_name, column_name FROM tmp_profile_fks
      LOOP
        -- private profile references
        BEGIN
          EXECUTE format('UPDATE %I.%I SET %I = $1 WHERE %I = $2',
            fk.table_schema, fk.table_name, fk.column_name, fk.column_name)
          USING v_canon_private, loser.private_profile_id;
        EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
          RAISE NOTICE 'merge_duplicate_class_enrollments: dropping conflicting rows in %.% (%) referencing loser private profile %',
            fk.table_schema, fk.table_name, fk.column_name, loser.private_profile_id;
          EXECUTE format('DELETE FROM %I.%I WHERE %I = $1',
            fk.table_schema, fk.table_name, fk.column_name)
          USING loser.private_profile_id;
        END;

        -- public profile references
        BEGIN
          EXECUTE format('UPDATE %I.%I SET %I = $1 WHERE %I = $2',
            fk.table_schema, fk.table_name, fk.column_name, fk.column_name)
          USING v_canon_public, loser.public_profile_id;
        EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
          RAISE NOTICE 'merge_duplicate_class_enrollments: dropping conflicting rows in %.% (%) referencing loser public profile %',
            fk.table_schema, fk.table_name, fk.column_name, loser.public_profile_id;
          EXECUTE format('DELETE FROM %I.%I WHERE %I = $1',
            fk.table_schema, fk.table_name, fk.column_name)
          USING loser.public_profile_id;
        END;
      END LOOP;

      DELETE FROM public.user_roles WHERE id = loser.id;
      DELETE FROM public.profiles WHERE id IN (loser.private_profile_id, loser.public_profile_id);

      v_merged := v_merged + 1;
    END LOOP;

    -- Survivor adopts the strongest role and stays active if any duplicate was.
    UPDATE public.user_roles
    SET role = v_best_role,
        disabled = CASE WHEN v_any_active THEN false ELSE disabled END
    WHERE id = v_canon_role_id;
  END LOOP;

  RETURN v_merged;
END;
$$;

COMMENT ON FUNCTION public.merge_duplicate_class_enrollments(bigint) IS
  'Collapses duplicate (user_id, class_id) enrollments onto one canonical profile pair, repointing all profiles(id) FKs. Idempotent. Pass a class_id to scope, or NULL for all classes.';

REVOKE ALL ON FUNCTION public.merge_duplicate_class_enrollments(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_class_enrollments(bigint) TO postgres;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_class_enrollments(bigint) TO service_role;

-- Enforce: at most one active enrollment per (user, class) going forward.
-- Existing data already satisfies this (no duplicate active (user, class) pairs),
-- so no backfill is run; the merge function above is available for manual use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_one_active_per_class
  ON public.user_roles (user_id, class_id)
  WHERE disabled = false;
