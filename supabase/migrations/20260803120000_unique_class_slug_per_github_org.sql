-- Enforce one class per (github_org, slug).
--
-- `slug` is the name every GitHub object for a class is derived from: teams are
-- `{slug}-staff` / `{slug}-students` and repos are `{slug}-{assignment}-...`. Two classes in the
-- same org sharing a slug therefore share one pair of teams, which breaks in three ways at once:
--   * each class's team sync computes its own intended member list and DELETES everyone else,
--     so the two classes evict each other's students from the shared team;
--   * syncRepoPermissions grants `{slug}-staff` maintain on both classes' student repos;
--   * the reverse lookups (markUserRoleOrgConfirmedForTeam, the membership webhook) resolve a
--     class from (org, slug) and match two rows, so they fail with PGRST116 and students are
--     never marked github_org_confirmed -- which then drops them from the team on the next sync.
--
-- Uniqueness is case-insensitive because GitHub team slugs are: `FA26-students` and
-- `fa26-students` are the same team, so those slugs collide even though the strings differ.

-- Build the index by hand only after confirming there is nothing to trip over: a bare
-- unique-violation from CREATE UNIQUE INDEX names one arbitrary row and leaves whoever is running
-- the migration to hunt for the rest.
DO $$
DECLARE
    v_duplicates text;
BEGIN
    SELECT string_agg(format('%s/%s (class ids %s)', github_org, slug, ids), '; ' ORDER BY github_org, slug)
      INTO v_duplicates
      FROM (
        SELECT lower(github_org) AS github_org,
               lower(slug) AS slug,
               string_agg(id::text, ',' ORDER BY id) AS ids
          FROM public.classes
         WHERE github_org IS NOT NULL AND slug IS NOT NULL
         GROUP BY lower(github_org), lower(slug)
        HAVING count(*) > 1
      ) d;

    IF v_duplicates IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot enforce unique (github_org, slug): these classes share a slug and must be renamed first: %', v_duplicates;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS classes_unique_github_org_slug
    ON public.classes (lower(github_org), lower(slug))
    WHERE github_org IS NOT NULL AND slug IS NOT NULL;

COMMENT ON INDEX public.classes_unique_github_org_slug IS
    'One class per (github_org, slug), case-insensitively: the slug determines GitHub team and repo names, so a shared slug makes two classes fight over one pair of teams.';

-- The index is the guarantee; this trigger is the error message. It names the conflicting class so
-- an admin who reuses a template prefix learns which class already has it, instead of getting a
-- bare 23505 from whichever write path they came in through (admin_create_class,
-- admin_update_class, or a service-role insert).
CREATE OR REPLACE FUNCTION public.check_class_slug_unique_in_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_conflict_id bigint;
    v_conflict_name text;
BEGIN
    IF NEW.github_org IS NULL OR NEW.slug IS NULL THEN
        RETURN NEW;
    END IF;

    -- On UPDATE, only re-check when the pair actually changed; most class updates touch neither.
    IF TG_OP = 'UPDATE'
       AND lower(NEW.github_org) = lower(OLD.github_org)
       AND lower(NEW.slug) = lower(OLD.slug) THEN
        RETURN NEW;
    END IF;

    SELECT c.id, c.name
      INTO v_conflict_id, v_conflict_name
      FROM public.classes c
     WHERE lower(c.github_org) = lower(NEW.github_org)
       AND lower(c.slug) = lower(NEW.slug)
       AND c.id IS DISTINCT FROM NEW.id
     LIMIT 1;

    IF v_conflict_id IS NOT NULL THEN
        RAISE EXCEPTION 'GitHub template prefix "%" is already used by class % (%) in org %. Each class in an org needs its own prefix: it names the class''s GitHub teams and repos.',
            NEW.slug, v_conflict_id, COALESCE(v_conflict_name, 'unnamed'), NEW.github_org;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_class_slug_unique_in_org ON public.classes;
CREATE TRIGGER check_class_slug_unique_in_org
    BEFORE INSERT OR UPDATE OF github_org, slug ON public.classes
    FOR EACH ROW
    EXECUTE FUNCTION public.check_class_slug_unique_in_org();

COMMENT ON FUNCTION public.check_class_slug_unique_in_org IS
    'Rejects a duplicate (github_org, slug) with an actionable message naming the conflicting class. The unique index classes_unique_github_org_slug is what makes this race-free.';
