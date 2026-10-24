import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { CLASS_SCOPED_CACHED_TABLES, classScopedTableTags, courseSsrTags, courseTag } from "@/lib/next-cache-tags";

/**
 * Issue #937 had a server-side half: `revalidateTag()` matches tag strings exactly, so a tag a
 * cached fetch is *read* under but nothing ever *emits* means the 1-hour TTL is the only thing
 * that refreshes it. That is invisible in review — both sides look correct in isolation.
 *
 * These tests pin the two halves to each other by reading the source, so adding a cached table
 * to `fetchCourseControllerData` without listing it here (or vice versa) fails in CI rather
 * than shipping an hour of staleness.
 */

const repoRoot = join(__dirname, "..", "..");
const ssrUtilsSource = readFileSync(join(repoRoot, "lib", "ssrUtils.ts"), "utf8");

const migrationsDir = join(repoRoot, "supabase", "migrations");
const allMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

describe("class-scoped cache tag coverage", () => {
  it("lists every class-scoped table that lib/ssrUtils.ts caches under a `<table>:<class>:<role>` tag", () => {
    // Matches the tag templates in `fetchCourseControllerData`, e.g.
    //   tags: [`gradebook_columns:${course_id}:${isStaff ? "staff" : "student"}`]
    const cachedInSsrUtils = new Set(
      [...ssrUtilsSource.matchAll(/`([a-z_]+):\$\{course_id\}:/g)].map((match) => match[1])
    );

    expect(cachedInSsrUtils.size).toBeGreaterThan(0);
    expect([...cachedInSsrUtils].sort()).toEqual([...CLASS_SCOPED_CACHED_TABLES].sort());
  });

  it("emits both role variants, matching what invalidate_class_scoped_cache() builds", () => {
    expect(classScopedTableTags("assignments", 7)).toEqual(["assignments:7:staff", "assignments:7:student"]);
  });

  it("has a Postgres trigger emitting the tag getCourse() reads", () => {
    // getCourse caches `select *` from classes under this tag for an hour. Before #937 nothing
    // emitted it, so a course rename or time-zone fix took up to an hour to appear.
    expect(courseTag(7)).toBe("course:7");
    expect(allMigrations).toContain("'course:' || class_id_value");
    expect(allMigrations).toMatch(/CREATE TRIGGER invalidate_classes_course_cache_update/);
  });

  it("has a Postgres trigger invalidating the bundles that embed assignment_groups_members", () => {
    expect(allMigrations).toMatch(/CREATE TRIGGER invalidate_assignment_groups_members_cache_insert/);
    expect(allMigrations).toContain("'user_roles:' || class_id_value || ':staff'");
  });
});

describe("courseSsrTags", () => {
  it("includes the tags that are actually read, not just the derived-dashboard no-ops", () => {
    const tags = courseSsrTags(7, ["assignments"]);

    expect(tags).toContain("course:7");
    expect(tags).toContain("assignments:7:staff");
    expect(tags).toContain("assignments:7:student");
    // The pre-#937 behaviour: these four were the *only* tags the client route emitted, and no
    // fetch is keyed under any of them. Kept for trigger-payload stability, never sufficient.
    expect(tags).toContain("course:7:assignments-overview");
  });

  it("scopes to the tables the caller names", () => {
    const tags = courseSsrTags(7, ["surveys"]);

    expect(tags).toContain("surveys:7:staff");
    expect(tags).not.toContain("gradebook_columns:7:staff");
  });
});
