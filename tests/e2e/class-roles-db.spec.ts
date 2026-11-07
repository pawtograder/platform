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
 * Step 4b (20261106140000_assignments_save_by_capability.sql): saving New and Edit Assignment follows
 * manage_assignments, in the database and in the edge functions those saves call.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import { test, expect } from "../global-setup";
import {
  supabase,
  createClass,
  createUserInClass,
  createAuthenticatedClient,
  insertAssignment,
  insertPreBakedSubmission,
  type TestingUser
} from "./TestingUtils";

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
  let rolesD: Awaited<ReturnType<typeof defaultRoles>>;

  test.beforeAll(async () => {
    classC = await createClass({ name: "E2E Custom Roles C" });
    classD = await createClass({ name: "E2E Custom Roles D" });
    instructorC = await createUserInClass({ role: "instructor", class_id: classC.id });
    graderC = await createUserInClass({ role: "grader", class_id: classC.id });
    studentC = await createUserInClass({ role: "student", class_id: classC.id });
    instructorD = await createUserInClass({ role: "instructor", class_id: classD.id });
    rolesC = await defaultRoles(classC.id);
    rolesD = await defaultRoles(classD.id);
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

    // The same refusals through the instructor's own client, so RLS and the trigger are both in play.
    for (const [user, app_role] of [
      [student, "student"],
      [otherInstructor, "instructor"]
    ] as const) {
      const row = await userRole(user);
      expectBlocked(
        await instructor.from("user_roles").update({ class_role_id: customId }).eq("id", row.id).select("id"),
        `an instructor putting a ${app_role} on a custom role`
      );
      expect((await userRole(user)).class_role_id).toBe(defaultC(app_role).id);
    }

    const { error: toInstructorError } = await supabase
      .from("user_roles")
      .update({ class_role_id: defaultC("instructor").id })
      .eq("id", graderRow.id);
    expect(toInstructorError, "a grader must not be put on the instructor role").not.toBeNull();
    expect((await userRole(grader)).class_role_id).toBe(customId);
  });

  test("a student can't be enrolled straight onto a custom role", async () => {
    const customId = await createCustomRole("Enrollment TA");
    const outsider = await createUserInClass({ role: "student", class_id: classD.id });
    const profile = async (is_private_profile: boolean) => {
      const { data, error } = await supabase
        .from("profiles")
        .insert({ name: "Insert test", class_id: classC.id, is_private_profile })
        .select("id")
        .single();
      expect(error).toBeNull();
      return data!.id;
    };
    const { error } = await supabase.from("user_roles").insert({
      user_id: outsider.user_id,
      class_id: classC.id,
      private_profile_id: await profile(true),
      public_profile_id: await profile(false),
      role: "student",
      class_role_id: customId
    });
    expect(error?.code, "the trigger refuses a custom role for a student on insert too").toBe("23514");
    const { data: rows, error: rowsError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", outsider.user_id)
      .eq("class_id", classC.id);
    expect(rowsError).toBeNull();
    expect(rows).toHaveLength(0);
  });

  test("a grader can't move themselves onto a custom role", async () => {
    const customId = await createCustomRole("Self-promoted TA", ["publish_groups"]);
    const grader = await createUserInClass({ role: "grader", class_id: classC.id });
    const row = await userRole(grader);
    const client = await createAuthenticatedClient(grader);
    expectBlocked(
      await client.from("user_roles").update({ class_role_id: customId }).eq("id", row.id).select("id"),
      "a grader moving themselves onto a custom role"
    );
    expect((await userRole(grader)).class_role_id).toBe(defaultC("grader").id);
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

  test("changing app_role and class_role_id in one update is refused", async () => {
    const customId = await createCustomRole("Combined TA");
    const user = await createUserInClass({ role: "student", class_id: classC.id });
    const row = await userRole(user);
    const { error } = await supabase
      .from("user_roles")
      .update({ role: "grader", class_role_id: customId })
      .eq("id", row.id);
    expect(error?.code, "the class role choice must not be dropped silently").toBe("23514");
    expect(await userRole(user)).toMatchObject({ role: "student", class_role_id: defaultC("student").id });
  });

  test("moving a grader on a custom role to another class resets them to that class's grader role", async () => {
    const customId = await createCustomRole("Travelling TA");
    const grader = await createUserInClass({ role: "grader", class_id: classC.id });
    const row = await userRole(grader);
    expect((await supabase.from("user_roles").update({ class_role_id: customId }).eq("id", row.id)).error).toBeNull();

    expect((await supabase.from("user_roles").update({ class_id: classD.id }).eq("id", row.id)).error).toBeNull();
    const { data: moved, error } = await supabase.from("user_roles").select("class_role_id").eq("id", row.id).single();
    expect(error).toBeNull();
    expect(moved!.class_role_id).toBe(rolesD.find((r) => r.default_for === "grader")!.id);
  });

  test("role names can't be blank, and are unique ignoring case", async () => {
    const instructor = await createAuthenticatedClient(instructorC);
    const { error: blankError } = await instructor.from("class_roles").insert({ class_id: classC.id, name: "   " });
    expect(blankError?.code, "a blank name is refused").toBe("23514");
    const { error: caseError } = await instructor
      .from("class_roles")
      .insert({ class_id: classC.id, name: "Instructor" });
    expect(caseError?.code, '"Instructor" can\'t sit next to the default "instructor"').toBe("23505");
  });

  test("the capability helpers only say something about the caller's own classes", async () => {
    for (const user of [graderC, instructorD]) {
      const client = await createAuthenticatedClient(user);
      const { data: capabilities, error } = await client.rpc("user_class_capabilities");
      expect(error).toBeNull();
      const { data: own, error: ownError } = await supabase
        .from("user_privileges")
        .select("class_id")
        .eq("user_id", user.user_id);
      expect(ownError).toBeNull();
      const ownClasses = new Set((own ?? []).map((p) => p.class_id));
      for (const row of capabilities ?? []) {
        expect(ownClasses.has(row.class_id), `class ${row.class_id} is one of the caller's`).toBe(true);
      }
    }
    const outsider = await createAuthenticatedClient(instructorD);
    const { data: classIds, error } = await outsider.rpc("user_class_ids_with_capability", {
      p_capability: "manage_roles"
    });
    expect(error).toBeNull();
    expect(classIds ?? []).toContain(classD.id);
    expect(classIds ?? [], "another class's instructor learns nothing about class C").not.toContain(classC.id);
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

test.describe("custom roles build on the default grader role", () => {
  let classE: Awaited<ReturnType<typeof createClass>>;
  let instructorE: TestingUser;
  let studentE: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let headTaRoleId: number;

  async function holds(user: TestingUser, capability: string) {
    const client = await createAuthenticatedClient(user);
    const { data, error } = await client.rpc("user_class_ids_with_capability", { p_capability: capability });
    expect(error).toBeNull();
    return (data ?? []).includes(classE.id);
  }

  // Changes the class's default roles directly, as a migration would: the default grader role gains
  // publish_groups and the default instructor role loses it, so a grader-base capability is visible
  // on its own.
  test.beforeAll(async () => {
    classE = await createClass({ name: "E2E Grader Base E" });
    instructorE = await createUserInClass({ role: "instructor", class_id: classE.id });
    studentE = await createUserInClass({ role: "student", class_id: classE.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classE.id });
    headTa = await createUserInClass({ role: "grader", class_id: classE.id });
    const roles = await defaultRoles(classE.id);
    const defaultFor = (app_role: string) => roles.find((r) => r.default_for === app_role)!.id;

    expect(
      (await supabase.from("role_capabilities").insert({ role_id: defaultFor("grader"), capability: "publish_groups" }))
        .error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", defaultFor("instructor"))
          .eq("capability", "publish_groups")
      ).error
    ).toBeNull();

    const { data: headTaRole, error } = await supabase
      .from("class_roles")
      .insert({ class_id: classE.id, name: "Head TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    headTaRoleId = headTaRole!.id;
    expect(
      (
        await supabase
          .from("role_capabilities")
          .insert({ role_id: headTaRoleId, capability: "manage_review_assignments" })
      ).error
    ).toBeNull();
    const row = await userRole(headTa);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: headTaRoleId }).eq("id", row.id)).error
    ).toBeNull();
  });

  test("a grader on a custom role holds its extras", async () => {
    expect(await holds(headTa, "manage_review_assignments"), "Head TA's extra").toBe(true);
    expect(await holds(plainGrader, "manage_review_assignments"), "not on the default grader role").toBe(false);
  });

  test("a capability on the default grader role reaches graders on custom roles", async () => {
    expect(await holds(plainGrader, "publish_groups")).toBe(true);
    expect(await holds(headTa, "publish_groups"), "a custom role builds on the grader base").toBe(true);
  });

  test("students and instructors gain nothing from the grader base", async () => {
    expect(await holds(studentE, "publish_groups")).toBe(false);
    expect(await holds(instructorE, "publish_groups")).toBe(false);
    expect(await holds(instructorE, "manage_roles"), "the instructor keeps their own role's capabilities").toBe(true);
  });

  test("a role manager can't grant a capability they don't hold", async () => {
    const instructor = await createAuthenticatedClient(instructorE);
    expectBlocked(
      await instructor
        .from("role_capabilities")
        .insert({ role_id: headTaRoleId, capability: "publish_groups" })
        .select("role_id"),
      "an instructor without publish_groups granting it"
    );
    expect(await roleCapabilities(headTaRoleId)).toEqual(["manage_review_assignments"]);
  });

  test("removing a capability from a custom role keeps it when the grader base has it", async () => {
    const instructor = await createAuthenticatedClient(instructorE);
    // Added as a migration would: this instructor doesn't hold publish_groups, so can't add it.
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: headTaRoleId, capability: "publish_groups" })).error
    ).toBeNull();
    const { data: removed, error } = await instructor
      .from("role_capabilities")
      .delete()
      .eq("role_id", headTaRoleId)
      .eq("capability", "publish_groups")
      .select("capability");
    expect(error).toBeNull();
    expect(removed).toHaveLength(1);
    expect(await holds(headTa, "publish_groups"), "a custom role can only add").toBe(true);
  });
});

test.describe("what useCapability reads (#1010, step 3)", () => {
  let classF: Awaited<ReturnType<typeof createClass>>;
  let classG: Awaited<ReturnType<typeof createClass>>;
  let instructorF: TestingUser;
  let studentF: TestingUser;
  let plainGraderF: TestingUser;
  let headTaF: TestingUser;
  let graderG: TestingUser;
  let headTaRoleId: number;

  async function capabilitiesOf(user: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const { data, error } = await client.rpc("user_class_capabilities");
    expect(error).toBeNull();
    return (data ?? []).map((row) => `${row.class_id}:${row.capability}`).sort();
  }

  // The default grader role gains publish_groups, and Head TA adds manage_review_assignments.
  test.beforeAll(async () => {
    classF = await createClass({ name: "E2E Use Capability F" });
    classG = await createClass({ name: "E2E Use Capability G" });
    instructorF = await createUserInClass({ role: "instructor", class_id: classF.id });
    studentF = await createUserInClass({ role: "student", class_id: classF.id });
    plainGraderF = await createUserInClass({ role: "grader", class_id: classF.id });
    headTaF = await createUserInClass({ role: "grader", class_id: classF.id });
    graderG = await createUserInClass({ role: "grader", class_id: classG.id });
    const roles = await defaultRoles(classF.id);
    const graderRoleId = roles.find((r) => r.default_for === "grader")!.id;

    expect(
      (await supabase.from("role_capabilities").insert({ role_id: graderRoleId, capability: "publish_groups" })).error
    ).toBeNull();
    const { data: headTaRole, error } = await supabase
      .from("class_roles")
      .insert({ class_id: classF.id, name: "Head TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    headTaRoleId = headTaRole!.id;
    expect(
      (
        await supabase
          .from("role_capabilities")
          .insert({ role_id: headTaRoleId, capability: "manage_review_assignments" })
      ).error
    ).toBeNull();
    const row = await userRole(headTaF);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: headTaRoleId }).eq("id", row.id)).error
    ).toBeNull();
  });

  test("user_class_capabilities() returns the role's extras plus the grader base, per class", async () => {
    expect(await capabilitiesOf(headTaF), "Head TA: the extra plus the grader base").toEqual([
      `${classF.id}:manage_review_assignments`,
      `${classF.id}:publish_groups`
    ]);
    expect(await capabilitiesOf(plainGraderF), "a plain grader doesn't get Head TA's extra").toEqual([
      `${classF.id}:publish_groups`
    ]);
    expect(await capabilitiesOf(graderG), "another class's grader gets nothing from this class").toEqual([]);
    expect(await capabilitiesOf(studentF), "a student gets nothing from the grader base").toEqual([]);
  });

  test("changing a custom role's capabilities sends a staff note for its class", async () => {
    const instructor = await createAuthenticatedClient(instructorF);
    const topic = `class:${classF.id}:staff`;
    const notes: Record<string, unknown>[] = [];

    // safe_broadcast only sends to channels with a live lease, as the app's RealtimeChannelManager registers.
    expect(
      (
        await instructor.rpc("register_realtime_subscription", {
          p_channel: topic,
          p_client_id: crypto.randomUUID()
        })
      ).error
    ).toBeNull();
    // The test client doesn't persist its session, so hand the realtime socket the token itself.
    const { data: session } = await instructor.auth.getSession();
    await instructor.realtime.setAuth(session.session!.access_token);
    const channel = instructor.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "broadcast" }, ({ payload }) => notes.push(payload));
    await new Promise<void>((resolve, reject) =>
      channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(err ?? new Error(status));
      })
    );

    try {
      const capabilityNotes = (operation: string) =>
        notes.filter((n) => n.table === "role_capabilities" && n.operation === operation);

      expect(
        (await instructor.from("role_capabilities").insert({ role_id: headTaRoleId, capability: "manage_assignments" }))
          .error
      ).toBeNull();
      await expect.poll(() => capabilityNotes("INSERT").length, { timeout: 15_000 }).toBe(1);

      expect(
        (
          await instructor
            .from("role_capabilities")
            .delete()
            .eq("role_id", headTaRoleId)
            .eq("capability", "manage_assignments")
        ).error
      ).toBeNull();
      await expect.poll(() => capabilityNotes("DELETE").length, { timeout: 15_000 }).toBe(1);

      for (const note of [...capabilityNotes("INSERT"), ...capabilityNotes("DELETE")]) {
        expect(note).toMatchObject({ type: "staff_data_change", class_id: classF.id, row_id: headTaRoleId });
      }
    } finally {
      await instructor.removeChannel(channel);
    }
  });
});

test.describe("saving assignments follows manage_assignments (#1010, step 4b)", () => {
  let classH: Awaited<ReturnType<typeof createClass>>;
  let instructorH: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;

  test.beforeAll(async () => {
    classH = await createClass({ name: "E2E Assignment Managers H" });
    instructorH = await createUserInClass({ role: "instructor", class_id: classH.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classH.id });
    headTa = await createUserInClass({ role: "grader", class_id: classH.id });

    const { data: headTaRole, error } = await supabase
      .from("class_roles")
      .insert({ class_id: classH.id, name: "Head TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: headTaRole!.id, capability: "manage_assignments" }))
        .error
    ).toBeNull();
    const row = await userRole(headTa);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: headTaRole!.id }).eq("id", row.id)).error
    ).toBeNull();
  });

  /** What New Assignment saves, in the same order: the self-review settings, then the assignment. */
  async function createAssignmentAs(user: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const { data: settings, error: settingsError } = await client
      .from("assignment_self_review_settings")
      .insert({ class_id: classH.id, enabled: false })
      .select("id")
      .single();
    if (settingsError) return { client, settingsError, assignmentError: null, id: null };
    const slug = `e2e-h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data: assignment, error: assignmentError } = await client
      .from("assignments")
      .insert({
        class_id: classH.id,
        title: `Lab ${slug}`,
        slug,
        due_date: addDays(new Date(), 7).toISOString(),
        group_config: "individual",
        self_review_setting_id: settings!.id
      })
      .select("id, self_review_setting_id")
      .single();
    return { client, settingsError, assignmentError, id: assignment?.id ?? null, settingsId: settings!.id };
  }

  async function assignmentTitle(id: number) {
    const { data, error } = await supabase.from("assignments").select("title").eq("id", id).single();
    expect(error).toBeNull();
    return data!.title;
  }

  test("a grader on a custom role with manage_assignments creates and edits a full assignment", async () => {
    const { client, settingsError, assignmentError, id, settingsId } = await createAssignmentAs(headTa);
    expect(settingsError).toBeNull();
    expect(assignmentError).toBeNull();

    // The AFTER INSERT trigger set up the autograder row and both rubrics.
    const { data: created, error: createdError } = await supabase
      .from("assignments")
      .select("grading_rubric_id, self_review_rubric_id, autograder(id)")
      .eq("id", id!)
      .single();
    expect(createdError).toBeNull();
    expect(created!.grading_rubric_id).not.toBeNull();
    expect(created!.self_review_rubric_id).not.toBeNull();
    expect(created!.autograder, "the trigger created the autograder row").not.toBeNull();

    // Edit Assignment: the assignment, its self-review settings, and the autograder row.
    const { data: renamed, error: renameError } = await client
      .from("assignments")
      .update({ title: "Renamed by Head TA" })
      .eq("id", id!)
      .select("id");
    expect(renameError).toBeNull();
    expect(renamed).toHaveLength(1);
    expect(await assignmentTitle(id!)).toBe("Renamed by Head TA");

    const { data: settingsUpdated, error: settingsUpdateError } = await client
      .from("assignment_self_review_settings")
      .update({ enabled: true, deadline_offset: 2 })
      .eq("id", settingsId!)
      .select("id");
    expect(settingsUpdateError).toBeNull();
    expect(settingsUpdated).toHaveLength(1);

    const { data: graderRow, error: graderReadError } = await client
      .from("autograder")
      .select("id, grader_repo")
      .eq("id", id!)
      .maybeSingle();
    expect(graderReadError).toBeNull();
    expect(graderRow, "Edit reads grader_repo before turning the autograder on").not.toBeNull();
    const { data: configured, error: configureError } = await client
      .from("autograder")
      .update({ max_submissions_count: 7 })
      .eq("id", id!)
      .select("id");
    expect(configureError).toBeNull();
    expect(configured).toHaveLength(1);
  });

  test("a default grader can't create or edit an assignment", async () => {
    const { settingsError } = await createAssignmentAs(plainGrader);
    expect(settingsError?.code, "creating self-review settings needs manage_assignments").toBe("42501");

    const existing = await insertAssignment({
      class_id: classH.id,
      due_date: addDays(new Date(), 7).toISOString(),
      assignment_slug: `e2e-h-existing-${Date.now().toString(36)}`
    });
    // Reuses the existing assignment's settings row, so the refused insert leaves nothing behind.
    const grader = await createAuthenticatedClient(plainGrader);
    const { error: insertError } = await grader.from("assignments").insert({
      class_id: classH.id,
      title: "Grader's assignment",
      slug: `e2e-h-grader-${Date.now().toString(36)}`,
      due_date: addDays(new Date(), 7).toISOString(),
      group_config: "individual",
      self_review_setting_id: existing.self_review_setting_id!
    });
    expect(insertError?.code, "creating an assignment needs manage_assignments").toBe("42501");

    const titleBefore = await assignmentTitle(existing.id);
    expectBlocked(
      await grader.from("assignments").update({ title: "Changed by a grader" }).eq("id", existing.id).select("id"),
      "a default grader editing an assignment"
    );
    expect(await assignmentTitle(existing.id)).toBe(titleBefore);

    const { data: graderRows, error: graderReadError } = await grader
      .from("autograder")
      .select("id")
      .eq("id", existing.id);
    expect(graderReadError).toBeNull();
    expect(graderRows ?? [], "a default grader can't read the autograder row").toHaveLength(0);
    expectBlocked(
      await grader.from("autograder").update({ max_submissions_count: 99 }).eq("id", existing.id).select("id"),
      "a default grader editing the autograder"
    );
  });

  test("a manage_assignments holder can queue student-repo syncs for their class, and a default grader can't", async () => {
    // Edit Assignment queues these through assignment-sync-autograder-workflow with the editor's JWT.
    const assignment = await insertAssignment({
      class_id: classH.id,
      due_date: addDays(new Date(), 7).toISOString(),
      assignment_slug: `e2e-h-sync-${Date.now().toString(36)}`
    });
    const student = await createUserInClass({ role: "student", class_id: classH.id });
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classH.id
    });
    const { data: repo, error: repoError } = await supabase
      .from("repositories")
      .select("id")
      .eq("repository", submission.repository_name)
      .single();
    expect(repoError).toBeNull();

    const grader = await createAuthenticatedClient(plainGrader);
    const { error: refused } = await grader.rpc("queue_repository_syncs", { p_repository_ids: [repo!.id] });
    expect(refused?.message ?? "", "a default grader is refused").toContain("manage_assignments is required");

    const client = await createAuthenticatedClient(headTa);
    const { error } = await client.rpc("queue_repository_syncs", { p_repository_ids: [repo!.id] });
    expect(error, "a Head TA can queue syncs for their class's repositories").toBeNull();
  });

  test("a manage_assignments holder can move release_date into the past, which creates student repos", async () => {
    // Before this fix the assignments trigger's call to create_all_repos_for_assignment refused a
    // Head TA and rolled back the whole save.
    const assignment = await insertAssignment({
      class_id: classH.id,
      due_date: addDays(new Date(), 14).toISOString(),
      release_date: addDays(new Date(), 7).toISOString(),
      assignment_slug: `e2e-h-release-${Date.now().toString(36)}`
    });
    expect(assignment.template_repo, "the trigger only creates repos when there is a handout").toBeTruthy();
    const pastRelease = new Date(Date.now() - 5 * 60_000).toISOString();

    const grader = await createAuthenticatedClient(plainGrader);
    expectBlocked(
      await grader.from("assignments").update({ release_date: pastRelease }).eq("id", assignment.id).select("id"),
      "a default grader moving the release date"
    );

    const client = await createAuthenticatedClient(headTa);
    const { data, error } = await client
      .from("assignments")
      .update({ release_date: pastRelease })
      .eq("id", assignment.id)
      .select("id");
    expect(error, "the save succeeds").toBeNull();
    expect(data).toHaveLength(1);
    const { data: after, error: afterError } = await supabase
      .from("assignments")
      .select("release_date")
      .eq("id", assignment.id)
      .single();
    expect(afterError).toBeNull();
    expect(new Date(after!.release_date!).getTime()).toBe(new Date(pastRelease).getTime());
  });

  test("a grader with manage_assignments still can't delete an assignment", async () => {
    const existing = await insertAssignment({
      class_id: classH.id,
      due_date: addDays(new Date(), 7).toISOString(),
      assignment_slug: `e2e-h-keep-${Date.now().toString(36)}`
    });
    const client = await createAuthenticatedClient(headTa);
    expectBlocked(
      await client.from("assignments").delete().eq("id", existing.id).select("id"),
      "a Head TA deleting an assignment"
    );
    const { data, error } = await supabase.from("assignments").select("id").eq("id", existing.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  test("an instructor still creates an assignment with its autograder row", async () => {
    const { settingsError, assignmentError, id } = await createAssignmentAs(instructorH);
    expect(settingsError).toBeNull();
    expect(assignmentError).toBeNull();
    const { data, error } = await supabase.from("autograder").select("id").eq("id", id!);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // The edge functions New and Edit call. A missing assignment fails after the access check, so a
  // caller who passes the check gets a different error than a refused one (401), and nothing reaches
  // GitHub.
  async function invokeAs(user: TestingUser, fn: string, body: Record<string, unknown>) {
    const client = await createAuthenticatedClient(user);
    const { error } = await client.functions.invoke(fn, { body });
    const response = (error as { context?: Response } | null)?.context;
    return { status: response?.status ?? null, text: response ? await response.text() : "" };
  }

  for (const fn of [
    "assignment-create-handout-repo",
    "assignment-create-solution-repo",
    "assignment-sync-autograder-workflow"
  ]) {
    test(`${fn} lets manage_assignments holders through and refuses default graders`, async () => {
      const body = { class_id: classH.id, assignment_id: 2_000_000_000 };
      expect((await invokeAs(plainGrader, fn, body)).status, "a default grader is refused").toBe(401);
      expect((await invokeAs(headTa, fn, body)).status, "a Head TA passes the access check").not.toBe(401);
    });
  }

  test("github-repo-configure-webhook lets manage_assignments holders through and refuses default graders", async () => {
    const assignment = await insertAssignment({
      class_id: classH.id,
      due_date: addDays(new Date(), 7).toISOString(),
      assignment_slug: `e2e-h-webhook-${Date.now().toString(36)}`
    });
    // A repository that doesn't exist: a caller who passes the check fails reading it, with nothing written.
    const body = {
      assignment_id: assignment.id,
      new_repo: "pawtograder-e2e-missing/does-not-exist",
      watch_type: "grader_solution"
    };
    // A default grader can't read the autograder row, so they are refused before the capability check.
    const refused = await invokeAs(plainGrader, "github-repo-configure-webhook", body);
    expect(refused.text, "a default grader is refused").toContain("Autograder not found");
    const passed = await invokeAs(headTa, "github-repo-configure-webhook", body);
    expect(passed.status, "a Head TA passes the access check").not.toBe(401);
    expect(passed.text, "a Head TA can read the autograder row").not.toContain("Autograder not found");
    expect(passed.text).not.toContain("does not have manage_assignments");
  });
});
