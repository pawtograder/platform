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
-- Two slugs collide when the TEAM NAMES they produce collide, which is a weaker condition than
-- string equality. GitHub derives a team's slug from its name by lowercasing and replacing runs of
-- non-alphanumerics with a hyphen, so `Fall 26` and `fall-26` are one team (`fall-26-students`)
-- even though neither `=` nor `lower()` says so — and the create-class form accepts any non-empty
-- prefix. Compare the derived team prefix instead. That is deliberately stricter than GitHub is in
-- the far edges of its normalization: a false reject costs an admin one retype, a false accept
-- recreates the production failure.
CREATE OR REPLACE FUNCTION public.github_team_slugify(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
-- Builtins are schema-qualified rather than pinned with SET search_path, so this stays usable in an
-- index expression. NOTE: classes_unique_github_org_slug indexes this function's output, so any
-- change to the body needs a REINDEX in the same migration.
AS $$
    SELECT pg_catalog.btrim(
               pg_catalog.regexp_replace(pg_catalog.lower(p_value), '[^a-z0-9]+', '-', 'g'),
               '-'
           );
$$;

COMMENT ON FUNCTION public.github_team_slugify IS
    'Approximates GitHub''s team name -> team slug normalization (lowercase, runs of non-alphanumerics to a single hyphen, trimmed). Used to compare class slugs by the GitHub team they would produce.';

-- Build the index by hand only after confirming there is nothing to trip over: a bare
-- unique-violation from CREATE UNIQUE INDEX names one arbitrary row and leaves whoever is running
-- the migration to hunt for the rest.
DO $$
DECLARE
    v_duplicates text;
BEGIN
    SELECT string_agg(format('%s/%s (%s)', github_org, team_prefix, rows), '; ' ORDER BY github_org, team_prefix)
      INTO v_duplicates
      FROM (
        SELECT lower(github_org) AS github_org,
               public.github_team_slugify(slug) AS team_prefix,
               string_agg(format('class %s slug %L', id, slug), ', ' ORDER BY id) AS rows
          FROM public.classes
         WHERE github_org IS NOT NULL AND slug IS NOT NULL
         GROUP BY lower(github_org), public.github_team_slugify(slug)
        HAVING count(*) > 1
      ) d;

    IF v_duplicates IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot enforce unique (github_org, slug): these classes resolve to the same GitHub team prefix and must be renamed first: %', v_duplicates;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS classes_unique_github_org_slug
    ON public.classes (lower(github_org), public.github_team_slugify(slug))
    WHERE github_org IS NOT NULL AND slug IS NOT NULL;

COMMENT ON INDEX public.classes_unique_github_org_slug IS
    'One class per (github_org, GitHub-normalized slug): the slug determines GitHub team and repo names, so two classes whose slugs produce the same team prefix would fight over one pair of teams.';

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
    v_conflict_slug text;
BEGIN
    IF NEW.github_org IS NULL OR NEW.slug IS NULL THEN
        RETURN NEW;
    END IF;

    -- On UPDATE, only re-check when the pair actually changed; most class updates touch neither.
    IF TG_OP = 'UPDATE'
       AND lower(NEW.github_org) = lower(OLD.github_org)
       AND public.github_team_slugify(NEW.slug) = public.github_team_slugify(OLD.slug) THEN
        RETURN NEW;
    END IF;

    SELECT c.id, c.name, c.slug
      INTO v_conflict_id, v_conflict_name, v_conflict_slug
      FROM public.classes c
     WHERE lower(c.github_org) = lower(NEW.github_org)
       AND public.github_team_slugify(c.slug) = public.github_team_slugify(NEW.slug)
       AND c.id IS DISTINCT FROM NEW.id
     LIMIT 1;

    IF v_conflict_id IS NOT NULL THEN
        -- Spell out the derived team prefix when the two slugs aren't identical, so "Fall 26
        -- conflicts with fall-26" doesn't read as a bug in the check.
        RAISE EXCEPTION 'GitHub template prefix "%" collides with class % (%), which uses prefix "%" in org %: both name the GitHub team "%". Each class in an org needs its own prefix -- it names the class''s GitHub teams and repos.',
            NEW.slug,
            v_conflict_id,
            COALESCE(v_conflict_name, 'unnamed'),
            v_conflict_slug,
            NEW.github_org,
            public.github_team_slugify(NEW.slug);
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
