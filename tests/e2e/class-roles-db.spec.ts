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
 * Step 2 (20261030120000_protect_class_roles.sql): holders of manage_roles (instructors) can create,
 * rename and delete custom roles and choose their capabilities, except manage_roles. Default roles
 * stay fixed, only graders can be on a custom role, and a change of app_role resets the role.
 * PostgREST reports a blocked insert, or a write without the column privilege, as an error, but
 * an update or delete that RLS hides changes 0 rows without one, so each blocked write is checked
 * with expectBlocked and then confirmed through the service client.
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

type WriteResult = { data: unknown[] | null; error: unknown };

function expectBlocked({ data, error }: WriteResult, what: string) {
  expect(error !== null || (data ?? []).length === 0, `${what} must be blocked`).toBe(true);
}

async function roleCapabilities(role_id: number) {
  const { data, error } = await supabase.from("role_capabilities").select("capability").eq("role_id", role_id);
  expect(error).toBeNull();
  return (data ?? []).map((rc) => rc.capability).sort();
}

async function classRole(id: number) {
  const { data, error } = await supabase
    .from("class_roles")
    .select("id, class_id, name, default_for")
    .eq("id", id)
    .maybeSingle();
  expect(error).toBeNull();
  return data;
}

test.describe("custom class roles", () => {
  let classC: Awaited<ReturnType<typeof createClass>>;
  let classD: Awaited<ReturnType<typeof createClass>>;
  let instructorC: TestingUser;
  let graderC: TestingUser;
  let studentC: TestingUser;
  let instructorD: TestingUser;
  let rolesC: Awaited<ReturnType<typeof defaultRoles>>;

  test.beforeAll(async () => {
    classC = await createClass({ name: "E2E Custom Roles C" });
    classD = await createClass({ name: "E2E Custom Roles D" });
    instructorC = await createUserInClass({ role: "instructor", class_id: classC.id });
    graderC = await createUserInClass({ role: "grader", class_id: classC.id });
    studentC = await createUserInClass({ role: "student", class_id: classC.id });
    instructorD = await createUserInClass({ role: "instructor", class_id: classD.id });
    rolesC = await defaultRoles(classC.id);
  });

  const defaultC = (app_role: string) => rolesC.find((r) => r.default_for === app_role)!;

  async function createCustomRole(name: string, capabilities: string[] = []) {
    const { data, error } = await supabase
      .from("class_roles")
      .insert({ class_id: classC.id, name })
      .select("id")
      .single();
    expect(error).toBeNull();
    if (capabilities.length > 0) {
      const { error: capError } = await supabase
        .from("role_capabilities")
        .insert(capabilities.map((capability) => ({ role_id: data!.id, capability })));
      expect(capError).toBeNull();
    }
    return data!.id;
  }

  test("an instructor can create, rename and delete a custom role, and choose its capabilities", async () => {
    const instructor = await createAuthenticatedClient(instructorC);

    const { data: created, error: createError } = await instructor
      .from("class_roles")
      .insert({ class_id: classC.id, name: "Head TA" })
      .select("id")
      .single();
    expect(createError).toBeNull();
    const roleId = created!.id;

    const { data: renamed, error: renameError } = await instructor
      .from("class_roles")
      .update({ name: "Lead TA" })
      .eq("id", roleId)
      .select("name");
    expect(renameError).toBeNull();
    expect(renamed).toEqual([{ name: "Lead TA" }]);

    const { error: addError } = await instructor
      .from("role_capabilities")
      .insert({ role_id: roleId, capability: "manage_review_assignments" });
    expect(addError).toBeNull();
    expect(await roleCapabilities(roleId)).toEqual(["manage_review_assignments"]);

    const { data: removed, error: removeError } = await instructor
      .from("role_capabilities")
      .delete()
      .eq("role_id", roleId)
      .eq("capability", "manage_review_assignments")
      .select("capability");
    expect(removeError).toBeNull();
    expect(removed).toHaveLength(1);

    const { data: deleted, error: deleteError } = await instructor
      .from("class_roles")
      .delete()
      .eq("id", roleId)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
    expect(await classRole(roleId)).toBeNull();
  });

  test("an instructor can't change default roles, move a role, or grant manage_roles", async () => {
    const instructor = await createAuthenticatedClient(instructorC);
    const instructorRole = defaultC("instructor");
    const graderRole = defaultC("grader");
    const customId = await createCustomRole("Grading TA");

    expectBlocked(
      await instructor.from("class_roles").update({ name: "renamed" }).eq("id", graderRole.id).select("id"),
      "renaming a default role"
    );
    expectBlocked(
      await instructor.from("class_roles").delete().eq("id", graderRole.id).select("id"),
      "deleting a default role"
    );
    expectBlocked(
      await instructor
        .from("class_roles")
        .insert({ class_id: classC.id, name: "fake grader", default_for: "grader" })
        .select("id"),
      "creating a default role"
    );
    expectBlocked(
      await instructor
        .from("class_roles")
        .insert({ id: 2_000_000_000, class_id: classC.id, name: "chosen id" })
        .select("id"),
      "choosing a role's id"
    );
    expectBlocked(
      await instructor
        .from("role_capabilities")
        .insert({ role_id: graderRole.id, capability: "manage_assignments" })
        .select("role_id"),
      "adding a capability to a default role"
    );
    expectBlocked(
      await instructor
        .from("role_capabilities")
        .delete()
        .eq("role_id", instructorRole.id)
        .eq("capability", "manage_assignments")
        .select("role_id"),
      "removing a capability from a default role"
    );
    expectBlocked(
      await instructor.from("class_roles").update({ default_for: "grader" }).eq("id", customId).select("id"),
      "changing default_for"
    );
    expectBlocked(
      await instructor.from("class_roles").update({ class_id: classD.id }).eq("id", customId).select("id"),
      "moving a role to another class"
    );
    expectBlocked(
      await instructor
        .from("role_capabilities")
        .insert({ role_id: customId, capability: "manage_roles" })
        .select("role_id"),
      "adding manage_roles to a custom role"
    );

    expect(await classRole(graderRole.id)).toEqual({
      id: graderRole.id,
      class_id: classC.id,
      name: graderRole.name,
      default_for: "grader"
    });
    expect(await roleCapabilities(graderRole.id)).toEqual([]);
    expect(await roleCapabilities(instructorRole.id)).toEqual(SEEDED_CAPABILITIES);
    expect(await classRole(customId)).toMatchObject({ class_id: classC.id, default_for: null });
    expect(await roleCapabilities(customId)).toEqual([]);
    const { data: fakeRoles, error: fakeRolesError } = await supabase
      .from("class_roles")
      .select("id")
      .eq("class_id", classC.id)
      .in("name", ["fake grader", "chosen id"]);
    expect(fakeRolesError).toBeNull();
    expect(fakeRoles).toHaveLength(0);
  });

  test("graders, students and other classes' instructors can't write class roles or their capabilities", async () => {
    const customId = await createCustomRole("Lab TA", ["publish_groups"]);

    for (const [user, who] of [
      [graderC, "a grader"],
      [studentC, "a student"],
      [instructorD, "another class's instructor"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      expectBlocked(
        await client
          .from("class_roles")
          .insert({ class_id: classC.id, name: `by ${who}` })
          .select("id"),
        `${who} creating a role`
      );
      expectBlocked(
        await client
          .from("class_roles")
          .update({ name: `by ${who}` })
          .eq("id", customId)
          .select("id"),
        `${who} renaming a role`
      );
      expectBlocked(
        await client.from("class_roles").delete().eq("id", customId).select("id"),
        `${who} deleting a role`
      );
      expectBlocked(
        await client
          .from("role_capabilities")
          .insert({ role_id: customId, capability: "manage_assignments" })
          .select("role_id"),
        `${who} adding a capability`
      );
      expectBlocked(
        await client
          .from("role_capabilities")
          .delete()
          .eq("role_id", customId)
          .eq("capability", "publish_groups")
          .select("role_id"),
        `${who} removing a capability`
      );
    }

    expect(await classRole(customId)).toMatchObject({ name: "Lab TA", class_id: classC.id });
    expect(await roleCapabilities(customId)).toEqual(["publish_groups"]);
    const { data: extra, error: extraError } = await supabase
      .from("class_roles")
      .select("id")
      .eq("class_id", classC.id)
      .like("name", "by %");
    expect(extraError).toBeNull();
    expect(extra).toHaveLength(0);
  });

  test("nobody can write capabilities", async () => {
    const instructor = await createAuthenticatedClient(instructorC);
    expectBlocked(
      await instructor.from("capabilities").insert({ name: "sneaky", description: "x" }).select("name"),
      "adding a capability"
    );
    expectBlocked(
      await instructor.from("capabilities").update({ description: "x" }).eq("name", "manage_roles").select("name"),
      "editing a capability"
    );
    expectBlocked(
      await instructor.from("capabilities").delete().eq("name", "manage_roles").select("name"),
      "deleting a capability"
    );

    const { data, error } = await supabase.from("capabilities").select("name, description");
    expect(error).toBeNull();
    expect((data ?? []).map((c) => c.name).sort()).toEqual(SEEDED_CAPABILITIES);
    expect(data!.find((c) => c.name === "manage_roles")!.description).not.toBe("x");
  });

  test("only graders can be on a custom role, and only on their class's grader roles", async () => {
    const customId = await createCustomRole("Head TA");
    const instructor = await createAuthenticatedClient(instructorC);

    const grader = await createUserInClass({ role: "grader", class_id: classC.id });
    const graderRow = await userRole(grader);
    const { data: moved, error: moveError } = await instructor
      .from("user_roles")
      .update({ class_role_id: customId })
      .eq("id", graderRow.id)
      .select("class_role_id");
    expect(moveError, "an instructor can put a grader on a custom role").toBeNull();
    expect(moved).toEqual([{ class_role_id: customId }]);

    const student = await createUserInClass({ role: "student", class_id: classC.id });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: classC.id });
    for (const [user, app_role] of [
      [student, "student"],
      [otherInstructor, "instructor"]
    ] as const) {
      const row = await userRole(user);
      const { error } = await supabase.from("user_roles").update({ class_role_id: customId }).eq("id", row.id);
      expect(error, `a ${app_role} must not be put on a custom role`).not.toBeNull();
      expect((await userRole(user)).class_role_id).toBe(defaultC(app_role).id);
    }

    const { error: toInstructorError } = await supabase
      .from("user_roles")
      .update({ class_role_id: defaultC("instructor").id })
      .eq("id", graderRow.id);
    expect(toInstructorError, "a grader must not be put on the instructor role").not.toBeNull();
    expect((await userRole(grader)).class_role_id).toBe(customId);
  });

  test("changing app_role always resets the role to the new default", async () => {
    const customId = await createCustomRole("Senior TA");
    const headTa = await createUserInClass({ role: "grader", class_id: classC.id });
    const row = await userRole(headTa);
    expect((await supabase.from("user_roles").update({ class_role_id: customId }).eq("id", row.id)).error).toBeNull();

    const privilegeRole = async () => {
      const { data, error } = await supabase
        .from("user_privileges")
        .select("class_role_id")
        .eq("user_id", headTa.user_id)
        .eq("class_id", classC.id)
        .single();
      expect(error).toBeNull();
      return data!.class_role_id;
    };

    expect((await supabase.from("user_roles").update({ role: "student" }).eq("id", row.id)).error).toBeNull();
    expect((await userRole(headTa)).class_role_id, "a Head TA changed to student lands on student").toBe(
      defaultC("student").id
    );
    expect(await privilegeRole()).toBe(defaultC("student").id);

    expect((await supabase.from("user_roles").update({ role: "grader" }).eq("id", row.id)).error).toBeNull();
    expect((await userRole(headTa)).class_role_id, "student back to grader lands on the default grader role").toBe(
      defaultC("grader").id
    );
    expect(await privilegeRole()).toBe(defaultC("grader").id);
  });

  test("a custom role someone is on can't be deleted", async () => {
    const customId = await createCustomRole("Exam TA");
    const grader = await createUserInClass({ role: "grader", class_id: classC.id });
    const row = await userRole(grader);
    expect((await supabase.from("user_roles").update({ class_role_id: customId }).eq("id", row.id)).error).toBeNull();

    const instructor = await createAuthenticatedClient(instructorC);
    const { error } = await instructor.from("class_roles").delete().eq("id", customId);
    expect(error, "the user_roles foreign key must block the delete").not.toBeNull();
    expect(await classRole(customId)).not.toBeNull();
    expect((await userRole(grader)).class_role_id).toBe(customId);
  });
});
