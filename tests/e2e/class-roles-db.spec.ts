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
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

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
    expect(error, "composite FK must reject a role from another class").not.toBeNull();
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

    const outsider = await createAuthenticatedClient(instructorB);
    const { data: foreign } = await outsider.from("class_roles").select("id").eq("class_id", classA.id);
    expect(foreign ?? [], "another class's staff must not read these roles").toHaveLength(0);
    const { data: foreignCaps } = await outsider
      .from("role_capabilities")
      .select("role_id")
      .in(
        "role_id",
        rolesA.map((r) => r.id)
      );
    expect(foreignCaps ?? []).toHaveLength(0);
  });
});
