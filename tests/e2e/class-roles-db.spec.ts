/**
 * DB-level coverage for the capability model foundation (#1010, step 1):
 * 20261027120000_class_roles_and_capabilities.sql.
 *
 * Every class gets default instructor, grader, student and admin roles, and each user_roles row gets
 * the default role for its app_role, copied to user_privileges. Only the instructor role holds the
 * seeded capabilities, which matches today's instructor-only checks: a class admin doesn't pass
 * authorizeforclassinstructor, so the admin role holds none.
 *
 * The capability tables decide what a user can do, so the negative assertions matter: a grader must
 * not be able to write them or move themselves to another role.
 *
 * The backfill only runs on real data in production, so one test replays the migration's backfill
 * blocks on a class put back into its pre-migration state, over a direct Postgres connection.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

// Same fallback as scripts/CheckFunctionGrants.ts.
const DB_URL =
  process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const MIGRATION = path.join(__dirname, "../../supabase/migrations/20261027120000_class_roles_and_capabilities.sql");

/** The statements between each `-- backfill:begin` and `-- backfill:end` marker, in order. */
function backfillBlocks() {
  const sql = readFileSync(MIGRATION, "utf8");
  const blocks = [...sql.matchAll(/-- backfill:begin[^\n]*\n([\s\S]*?)-- backfill:end/g)].map((m) => m[1]);
  expect(blocks.length, "the migration marks its backfill blocks").toBe(3);
  return blocks;
}

const SEEDED_CAPABILITIES = ["manage_assignments", "manage_review_assignments", "manage_roles", "publish_groups"];
const DEFAULT_ROLES = ["admin", "grader", "instructor", "student"];

async function defaultRoles(class_id: number) {
  const { data, error } = await supabase
    .from("class_roles")
    .select("id, name, default_for, role_capabilities(capability)")
    .eq("class_id", class_id);
  expect(error).toBeNull();
  return data ?? [];
}

async function userRole(user: TestingUser) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("id, role, class_role_id")
    .eq("user_id", user.user_id)
    .eq("class_id", user.class_id)
    .single();
  expect(error).toBeNull();
  return data!;
}

test.describe("class roles and capabilities", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructorA: TestingUser;
  let graderA: TestingUser;
  let studentA: TestingUser;
  let instructorB: TestingUser;
  let rolesA: Awaited<ReturnType<typeof defaultRoles>>;
  let rolesB: Awaited<ReturnType<typeof defaultRoles>>;

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Class Roles A" });
    classB = await createClass({ name: "E2E Class Roles B" });
    instructorA = await createUserInClass({ role: "instructor", class_id: classA.id });
    graderA = await createUserInClass({ role: "grader", class_id: classA.id });
    studentA = await createUserInClass({ role: "student", class_id: classA.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });
    rolesA = await defaultRoles(classA.id);
    rolesB = await defaultRoles(classB.id);
  });

  const roleFor = (roles: typeof rolesA, app_role: string) => roles.find((r) => r.default_for === app_role)!;

  test("a new class gets default roles, and only instructor holds the seeded capabilities", async () => {
    expect(rolesA.map((r) => r.default_for).sort()).toEqual(DEFAULT_ROLES);
    const capabilitiesOf = (app_role: string) =>
      roleFor(rolesA, app_role)
        .role_capabilities.map((rc) => rc.capability)
        .sort();
    expect(capabilitiesOf("instructor")).toEqual(SEEDED_CAPABILITIES);
    expect(capabilitiesOf("grader")).toEqual([]);
    expect(capabilitiesOf("student")).toEqual([]);
    expect(capabilitiesOf("admin")).toEqual([]);
  });

  test("each user gets the default role for their app_role, copied to user_privileges", async () => {
    for (const [user, app_role] of [
      [instructorA, "instructor"],
      [graderA, "grader"],
      [studentA, "student"]
    ] as const) {
      const row = await userRole(user);
      expect(row.class_role_id).toBe(roleFor(rolesA, app_role).id);

      const { data: priv, error } = await supabase
        .from("user_privileges")
        .select("class_role_id")
        .eq("user_id", user.user_id)
        .eq("class_id", user.class_id)
        .single();
      expect(error).toBeNull();
      expect(priv!.class_role_id).toBe(row.class_role_id);
    }
  });

  test("changing app_role moves a user on a default role to the new default role", async () => {
    const promoted = await createUserInClass({ role: "grader", class_id: classA.id });
    const before = await userRole(promoted);
    const { error } = await supabase.from("user_roles").update({ role: "instructor" }).eq("id", before.id);
    expect(error).toBeNull();
    expect((await userRole(promoted)).class_role_id).toBe(roleFor(rolesA, "instructor").id);
  });

  test("an admin row gets the admin role, which holds no capabilities", async () => {
    const admin = await createUserInClass({ role: "student", class_id: classA.id });
    const before = await userRole(admin);
    const { error } = await supabase.from("user_roles").update({ role: "admin" }).eq("id", before.id);
    expect(error).toBeNull();

    const after = await userRole(admin);
    expect(after.class_role_id, "admin must not get the instructor role").toBe(roleFor(rolesA, "admin").id);
    const { data: priv, error: privError } = await supabase
      .from("user_privileges")
      .select("class_role_id")
      .eq("user_id", admin.user_id)
      .eq("class_id", admin.class_id)
      .single();
    expect(privError).toBeNull();
    expect(priv!.class_role_id).toBe(after.class_role_id);
  });

  test("a user cannot be given another class's role", async () => {
    const row = await userRole(studentA);
    const { error } = await supabase
      .from("user_roles")
      .update({ class_role_id: roleFor(rolesB, "instructor").id })
      .eq("id", row.id);
    expect(error?.code, "composite FK must reject a role from another class").toBe("23503");
  });

  test("moving a user to another class moves their role and user_privileges with them", async () => {
    const mover = await createUserInClass({ role: "student", class_id: classA.id });
    const before = await userRole(mover);
    const { error } = await supabase.from("user_roles").update({ class_id: classB.id }).eq("id", before.id);
    expect(error).toBeNull();

    const { data: after, error: afterError } = await supabase
      .from("user_roles")
      .select("class_role_id")
      .eq("id", before.id)
      .single();
    expect(afterError).toBeNull();
    expect(after!.class_role_id).toBe(roleFor(rolesB, "student").id);

    const { data: privs, error: privError } = await supabase
      .from("user_privileges")
      .select("class_id, class_role_id")
      .eq("user_id", mover.user_id)
      .in("class_id", [classA.id, classB.id]);
    expect(privError).toBeNull();
    expect(privs, "user_privileges follows the class change").toEqual([
      { class_id: classB.id, class_role_id: roleFor(rolesB, "student").id }
    ]);
  });

  test("the migration's backfill gives every existing row its default role without firing triggers", async () => {
    const backfillClass = await createClass({ name: "E2E Class Roles backfill" });
    for (const role of ["instructor", "grader", "student", "student"] as const) {
      await createUserInClass({ role, class_id: backfillClass.id });
    }
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    try {
      // Everything runs in one transaction and is rolled back. The ALTER TABLEs lock user_roles
      // until then, so keep this short.
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout = '10s'");
      // Put the class back into its pre-migration state: no class roles, no class_role_id.
      await db.query("ALTER TABLE public.user_roles ALTER COLUMN class_role_id DROP NOT NULL");
      await db.query("ALTER TABLE public.user_roles DISABLE TRIGGER USER");
      await db.query("UPDATE public.user_roles SET class_role_id = NULL WHERE class_id = $1", [backfillClass.id]);
      await db.query("ALTER TABLE public.user_roles ENABLE TRIGGER USER");
      await db.query("UPDATE public.user_privileges SET class_role_id = NULL WHERE class_id = $1", [backfillClass.id]);
      await db.query("DELETE FROM public.class_roles WHERE class_id = $1", [backfillClass.id]);
      const updatedAt = async () =>
        (
          await db.query("SELECT id, updated_at FROM public.user_roles WHERE class_id = $1 ORDER BY id", [
            backfillClass.id
          ])
        ).rows;
      const updatedAtBefore = await updatedAt();

      for (const block of backfillBlocks()) {
        await db.query(block);
      }

      const count = async (sql: string) => Number((await db.query(sql, [backfillClass.id])).rows[0].n);
      expect(
        await count("SELECT count(*) AS n FROM public.class_roles WHERE class_id = $1 AND default_for IS NOT NULL"),
        "the class gets its four default roles"
      ).toBe(4);
      expect(
        await count(`SELECT count(*) AS n FROM public.role_capabilities rc
          JOIN public.class_roles cr ON cr.id = rc.role_id
          WHERE cr.class_id = $1 AND cr.default_for = 'instructor'`),
        "the instructor role gets every capability"
      ).toBe(SEEDED_CAPABILITIES.length);
      expect(
        await count("SELECT count(*) AS n FROM public.user_roles WHERE class_id = $1 AND class_role_id IS NULL"),
        "no user_roles row is left without a role"
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM public.user_roles ur
          JOIN public.class_roles cr ON cr.id = ur.class_role_id
          WHERE ur.class_id = $1 AND (cr.class_id <> ur.class_id OR cr.default_for IS DISTINCT FROM ur.role)`),
        "every user_roles row is on its class's default role for its app_role"
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM public.user_privileges up
          JOIN public.user_roles ur
            ON ur.user_id = up.user_id AND ur.class_id = up.class_id AND ur.role = up.role AND NOT ur.disabled
          WHERE up.class_id = $1 AND up.class_role_id IS DISTINCT FROM ur.class_role_id`),
        "user_privileges matches user_roles"
      ).toBe(0);
      expect(await updatedAt(), "no user_roles trigger ran (updated_at is unchanged)").toEqual(updatedAtBefore);
    } finally {
      await db.query("ROLLBACK").catch(() => {});
      await db.end();
    }
  });

  test("a grader cannot write the capability tables or change their own role", async () => {
    const authed = await createAuthenticatedClient(graderA);
    const instructorRole = roleFor(rolesA, "instructor");

    await authed
      .from("role_capabilities")
      .insert({ role_id: roleFor(rolesA, "grader").id, capability: "manage_roles" });
    await authed.from("class_roles").insert({ class_id: classA.id, name: "sneaky" });
    const row = await userRole(graderA);
    await authed.from("user_roles").update({ class_role_id: instructorRole.id }).eq("id", row.id);

    const after = await defaultRoles(classA.id);
    expect(after.map((r) => r.name).sort(), "no role was added").toEqual(DEFAULT_ROLES);
    expect(roleFor(after, "grader").role_capabilities, "grader gained no capability").toHaveLength(0);
    expect((await userRole(graderA)).class_role_id, "grader is still on the grader role").toBe(
      roleFor(rolesA, "grader").id
    );
  });

  test("class members can read their class's roles, and other classes cannot", async () => {
    const member = await createAuthenticatedClient(studentA);
    const { data: own, error } = await member.from("class_roles").select("id").eq("class_id", classA.id);
    expect(error).toBeNull();
    expect(own ?? [], "a member must read their class's roles").toHaveLength(DEFAULT_ROLES.length);
    const { data: ownCaps, error: ownCapsError } = await member
      .from("role_capabilities")
      .select("role_id")
      .in(
        "role_id",
        rolesA.map((r) => r.id)
      );
    expect(ownCapsError).toBeNull();
    expect(ownCaps ?? [], "a member must read their class's capability mappings").toHaveLength(
      SEEDED_CAPABILITIES.length
    );

    // RLS hides rows instead of raising, so check the error first: a null result from an error must not pass.
    const outsider = await createAuthenticatedClient(instructorB);
    const { data: foreign, error: foreignError } = await outsider
      .from("class_roles")
      .select("id")
      .eq("class_id", classA.id);
    expect(foreignError).toBeNull();
    expect(foreign ?? [], "another class's staff must not read these roles").toHaveLength(0);
    const { data: foreignCaps, error: foreignCapsError } = await outsider
      .from("role_capabilities")
      .select("role_id")
      .in(
        "role_id",
        rolesA.map((r) => r.id)
      );
    expect(foreignCapsError).toBeNull();
    expect(foreignCaps ?? []).toHaveLength(0);
  });
});
