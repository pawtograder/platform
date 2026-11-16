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
 * Step 5 (20261108120000_review_assignments_by_capability.sql): seeing and deleting review
 * assignments follow manage_review_assignments, while creating and editing them stay instructor-only.
 *
 * 20261114120000_custom_roles_copy_grader_role.sql: a user holds only their own class role's
 * capabilities. A new custom role starts as a copy of the default grader role, and instructors can
 * edit the default grader role. This replaces step 2's "custom roles only add" rule.
 *
 * 20261115220000_flashcards_manage_by_capability.sql: creating, editing and deleting flashcard decks
 * and cards follow manage_flashcards. Graders held that access before, so it is on the default grader
 * role and every custom role. The old creator OR on deck/card writes is gone, so a creator without
 * the capability (or a demoted former grader) cannot manage decks they made.
 *
 * 20261116120000_surveys_polls_by_capability.sql: survey staff writes follow manage_surveys
 * (instructor only); live-poll staff writes follow run_polls (on the default grader role and every
 * custom role, since graders could run polls before).
 *
 * 20261117120000_office_hours_by_capability.sql: staff help-request actions follow help_students
 * (on the default grader role and every custom role); instructor-only office-hours configuration
 * follows manage_office_hours.
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
  insertOfficeHoursQueue,
  insertHelpRequest,
  type TestingUser
} from "./TestingUtils";

const SEEDED_CAPABILITIES = [
  "help_students",
  "manage_assignments",
  "manage_flashcards",
  "manage_office_hours",
  "manage_review_assignments",
  "manage_roles",
  "manage_surveys",
  "publish_groups",
  "run_polls"
];
/** Capabilities seed_default_class_roles() puts on the default grader role (not only instructor). */
const GRADER_SEEDED_CAPABILITIES = ["help_students", "manage_flashcards", "run_polls"];
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

  test("a new class gets default roles, and instructor holds every seeded capability", async () => {
    expect(rolesA.map((r) => r.default_for).sort()).toEqual(DEFAULT_ROLES);
    const capabilitiesOf = (app_role: string) =>
      roleFor(rolesA, app_role)
        .role_capabilities.map((rc) => rc.capability)
        .sort();
    expect(capabilitiesOf("instructor")).toEqual(SEEDED_CAPABILITIES);
    expect(capabilitiesOf("grader")).toEqual(GRADER_SEEDED_CAPABILITIES);
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
    expect(
      roleFor(after, "grader")
        .role_capabilities.map((rc) => rc.capability)
        .sort(),
      "grader capabilities unchanged by the attempt"
    ).toEqual(GRADER_SEEDED_CAPABILITIES);
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
      SEEDED_CAPABILITIES.length + GRADER_SEEDED_CAPABILITIES.length
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

// For an insert that must be refused by RLS itself. Postgres checks an INSERT policy before the
// primary key, so a working policy gives 42501 even when the row already exists; a policy that let
// the row through would give 23505 (duplicate key) instead, which expectBlocked would also accept.
function expectRlsBlocked({ error }: WriteResult, what: string) {
  expect((error as { code?: string } | null)?.code, `${what} must be refused by RLS`).toBe("42501");
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
    // The copy trigger already put grader-seeded capabilities on the new role from the default grader role.
    expect(await roleCapabilities(roleId)).toEqual([
      "help_students",
      "manage_flashcards",
      "manage_review_assignments",
      "run_polls"
    ]);

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

  test("an instructor can't rename or delete default roles, edit the other default roles, move a role, or grant manage_roles", async () => {
    const instructor = await createAuthenticatedClient(instructorC);
    const instructorRole = defaultC("instructor");
    const graderRole = defaultC("grader");
    const customId = await createCustomRole("Grading TA");

    // The default instructor role already holds publish_groups, so only the error code shows the
    // policy refused the insert (see expectRlsBlocked).
    for (const app_role of ["instructor", "student", "admin"]) {
      expectRlsBlocked(
        await instructor
          .from("role_capabilities")
          .insert({ role_id: defaultC(app_role).id, capability: "publish_groups" })
          .select("role_id"),
        `adding a capability to the default ${app_role} role`
      );
    }
    expectBlocked(
      await instructor
        .from("role_capabilities")
        .insert({ role_id: graderRole.id, capability: "manage_roles" })
        .select("role_id"),
      "adding manage_roles to the default grader role"
    );

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
        .delete()
        .eq("role_id", instructorRole.id)
        .eq("capability", "manage_assignments")
        .select("role_id"),
      "removing a capability from the default instructor role"
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
    expect(await roleCapabilities(graderRole.id)).toEqual(GRADER_SEEDED_CAPABILITIES);
    expect(await roleCapabilities(instructorRole.id)).toEqual(SEEDED_CAPABILITIES);
    for (const app_role of ["student", "admin"]) {
      expect(await roleCapabilities(defaultC(app_role).id), `the default ${app_role} role`).toEqual([]);
    }
    expect(await classRole(customId)).toMatchObject({ class_id: classC.id, default_for: null });
    expect(await roleCapabilities(customId)).toEqual(GRADER_SEEDED_CAPABILITIES);
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
    expect(await roleCapabilities(customId)).toEqual([
      "help_students",
      "manage_flashcards",
      "publish_groups",
      "run_polls"
    ]);
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

test.describe("custom roles start as a copy of the default grader role", () => {
  let classE: Awaited<ReturnType<typeof createClass>>;
  let instructorE: TestingUser;
  let studentE: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let coordinator: TestingUser;
  let graderRoleId: number;
  let headTaRoleId: number;
  let coordinatorRoleId: number;

  async function holds(user: TestingUser, capability: string, class_id = classE.id) {
    const client = await createAuthenticatedClient(user);
    const { data, error } = await client.rpc("user_class_ids_with_capability", { p_capability: capability });
    expect(error).toBeNull();
    return (data ?? []).includes(class_id);
  }

  // Roles are made through the instructor's own client, as the roles page does.
  async function createRoleAsInstructor(name: string) {
    const instructor = await createAuthenticatedClient(instructorE);
    const { data, error } = await instructor
      .from("class_roles")
      .insert({ class_id: classE.id, name })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function putOnRole(user: TestingUser, role_id: number) {
    const row = await userRole(user);
    expect((await supabase.from("user_roles").update({ class_role_id: role_id }).eq("id", row.id)).error).toBeNull();
  }

  // The default grader role already holds help_students, manage_flashcards and run_polls; this also gives it
  // publish_groups, as a migration would. Head TA turns manage_review_assignments on; Course
  // coordinator turns publish_groups off (and keeps the grader-seeded capabilities).
  test.beforeAll(async () => {
    classE = await createClass({ name: "E2E Grader Copy E" });
    instructorE = await createUserInClass({ role: "instructor", class_id: classE.id });
    studentE = await createUserInClass({ role: "student", class_id: classE.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classE.id });
    headTa = await createUserInClass({ role: "grader", class_id: classE.id });
    coordinator = await createUserInClass({ role: "grader", class_id: classE.id });
    graderRoleId = (await defaultRoles(classE.id)).find((r) => r.default_for === "grader")!.id;
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: graderRoleId, capability: "publish_groups" })).error
    ).toBeNull();

    const instructor = await createAuthenticatedClient(instructorE);
    headTaRoleId = await createRoleAsInstructor("Head TA");
    expect(
      (
        await instructor
          .from("role_capabilities")
          .insert({ role_id: headTaRoleId, capability: "manage_review_assignments" })
      ).error
    ).toBeNull();
    await putOnRole(headTa, headTaRoleId);

    coordinatorRoleId = await createRoleAsInstructor("Course coordinator");
    const { data: removed, error: removeError } = await instructor
      .from("role_capabilities")
      .delete()
      .eq("role_id", coordinatorRoleId)
      .eq("capability", "publish_groups")
      .select("capability");
    expect(removeError).toBeNull();
    expect(removed, "the copied default can be turned off").toHaveLength(1);
    await putOnRole(coordinator, coordinatorRoleId);
  });

  test("a new custom role starts with the default grader role's capabilities, without manage_roles", async () => {
    // manage_roles can't be put on the default grader role through the app; a migration could.
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: graderRoleId, capability: "manage_roles" })).error
    ).toBeNull();
    try {
      const roleId = await createRoleAsInstructor("Copied TA");
      expect(await roleCapabilities(roleId)).toEqual([
        "help_students",
        "manage_flashcards",
        "publish_groups",
        "run_polls"
      ]);
    } finally {
      expect(
        (await supabase.from("role_capabilities").delete().eq("role_id", graderRoleId).eq("capability", "manage_roles"))
          .error
      ).toBeNull();
    }
  });

  test("a grader on a custom role holds what that role turns on", async () => {
    expect(await roleCapabilities(headTaRoleId)).toEqual([
      "help_students",
      "manage_flashcards",
      "manage_review_assignments",
      "publish_groups",
      "run_polls"
    ]);
    expect(await holds(headTa, "manage_review_assignments"), "Head TA's extra").toBe(true);
    expect(await holds(headTa, "publish_groups"), "copied from the default grader role").toBe(true);
    expect(await holds(plainGrader, "manage_review_assignments"), "not on the default grader role").toBe(false);
  });

  test("a custom role can turn a default off, so it holds less than a plain grader", async () => {
    expect(await roleCapabilities(coordinatorRoleId)).toEqual(["help_students", "manage_flashcards", "run_polls"]);
    expect(await holds(coordinator, "publish_groups"), "the coordinator turned it off").toBe(false);
    expect(await holds(plainGrader, "publish_groups"), "plain graders keep it").toBe(true);
  });

  test("an instructor can edit the default grader role, and roles made earlier don't change", async () => {
    const instructor = await createAuthenticatedClient(instructorE);
    expect(
      (await instructor.from("role_capabilities").insert({ role_id: graderRoleId, capability: "manage_assignments" }))
        .error
    ).toBeNull();
    expect(await holds(plainGrader, "manage_assignments"), "plain graders gain it").toBe(true);
    expect(await holds(headTa, "manage_assignments"), "a copy made earlier stays as it was").toBe(false);

    const { data: removed, error } = await instructor
      .from("role_capabilities")
      .delete()
      .eq("role_id", graderRoleId)
      .eq("capability", "manage_assignments")
      .select("capability");
    expect(error).toBeNull();
    expect(removed).toHaveLength(1);
    expect(await holds(plainGrader, "manage_assignments"), "plain graders lose it").toBe(false);
  });

  test("instructors still hold every capability, and students hold none", async () => {
    for (const capability of SEEDED_CAPABILITIES) {
      expect(await holds(instructorE, capability), `instructor: ${capability}`).toBe(true);
      expect(await holds(studentE, capability), `student: ${capability}`).toBe(false);
    }
  });

  test("a role manager can't grant a capability they don't hold", async () => {
    // A class whose instructor role lacks manage_assignments, as after a migration took it away.
    const classX = await createClass({ name: "E2E Grader Copy X" });
    const instructorX = await createUserInClass({ role: "instructor", class_id: classX.id });
    const rolesX = await defaultRoles(classX.id);
    const roleX = (app_role: string) => rolesX.find((r) => r.default_for === app_role)!.id;
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", roleX("instructor"))
          .eq("capability", "manage_assignments")
      ).error
    ).toBeNull();
    const instructor = await createAuthenticatedClient(instructorX);
    const { data: custom, error } = await instructor
      .from("class_roles")
      .insert({ class_id: classX.id, name: "Head TA" })
      .select("id")
      .single();
    expect(error).toBeNull();

    for (const [role_id, which] of [
      [roleX("grader"), "the default grader role"],
      [custom!.id, "a custom role"]
    ] as const) {
      expectBlocked(
        await instructor
          .from("role_capabilities")
          .insert({ role_id, capability: "manage_assignments" })
          .select("role_id"),
        `granting manage_assignments to ${which} without holding it`
      );
      // manage_flashcards is already on the grader role and was copied onto the custom role.
      expect(await roleCapabilities(role_id), which).toEqual(GRADER_SEEDED_CAPABILITIES);
    }

    // Nor through the copy: a role made from a default grader role that has it doesn't get it.
    expect(
      (
        await supabase.from("role_capabilities").insert([
          { role_id: roleX("grader"), capability: "manage_assignments" },
          { role_id: roleX("grader"), capability: "publish_groups" }
        ])
      ).error
    ).toBeNull();
    const { data: copied, error: copyError } = await instructor
      .from("class_roles")
      .insert({ class_id: classX.id, name: "Copied TA" })
      .select("id")
      .single();
    expect(copyError).toBeNull();
    expect(await roleCapabilities(copied!.id), "only what the creator holds is copied").toEqual([
      "help_students",
      "manage_flashcards",
      "publish_groups",
      "run_polls"
    ]);
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
  let graderRoleId: number;

  async function capabilitiesOf(user: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const { data, error } = await client.rpc("user_class_capabilities");
    expect(error).toBeNull();
    return (data ?? []).map((row) => `${row.class_id}:${row.capability}`).sort();
  }

  // The default grader role gains publish_groups, then Head TA is made (a copy, so it has
  // publish_groups too) and adds manage_review_assignments.
  test.beforeAll(async () => {
    classF = await createClass({ name: "E2E Use Capability F" });
    classG = await createClass({ name: "E2E Use Capability G" });
    instructorF = await createUserInClass({ role: "instructor", class_id: classF.id });
    studentF = await createUserInClass({ role: "student", class_id: classF.id });
    plainGraderF = await createUserInClass({ role: "grader", class_id: classF.id });
    headTaF = await createUserInClass({ role: "grader", class_id: classF.id });
    graderG = await createUserInClass({ role: "grader", class_id: classG.id });
    const roles = await defaultRoles(classF.id);
    graderRoleId = roles.find((r) => r.default_for === "grader")!.id;

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

  test("user_class_capabilities() returns the user's own role's capabilities, per class", async () => {
    expect(await capabilitiesOf(headTaF), "Head TA: the copy plus the extra").toEqual([
      `${classF.id}:help_students`,
      `${classF.id}:manage_flashcards`,
      `${classF.id}:manage_review_assignments`,
      `${classF.id}:publish_groups`,
      `${classF.id}:run_polls`
    ]);
    expect(await capabilitiesOf(plainGraderF), "a plain grader doesn't get Head TA's extra").toEqual([
      `${classF.id}:help_students`,
      `${classF.id}:manage_flashcards`,
      `${classF.id}:publish_groups`,
      `${classF.id}:run_polls`
    ]);
    // graderG holds grader-seeded capabilities in classG, not anything from classF.
    expect(await capabilitiesOf(graderG), "another class's grader gets nothing from this class").toEqual([
      `${classG.id}:help_students`,
      `${classG.id}:manage_flashcards`,
      `${classG.id}:run_polls`
    ]);
    expect(await capabilitiesOf(studentF), "a student gets nothing from the grader role").toEqual([]);
  });

  test("changing a custom or default grader role's capabilities sends a staff note for its class", async () => {
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

      // The default grader role is editable now, so plain graders' pages must hear about it too.
      expect(
        (await instructor.from("role_capabilities").insert({ role_id: graderRoleId, capability: "manage_assignments" }))
          .error
      ).toBeNull();
      await expect.poll(() => capabilityNotes("INSERT").length, { timeout: 15_000 }).toBe(2);
      expect(
        (
          await instructor
            .from("role_capabilities")
            .delete()
            .eq("role_id", graderRoleId)
            .eq("capability", "manage_assignments")
        ).error
      ).toBeNull();
      await expect.poll(() => capabilityNotes("DELETE").length, { timeout: 15_000 }).toBe(2);
      for (const note of [capabilityNotes("INSERT")[1], capabilityNotes("DELETE")[1]]) {
        expect(note).toMatchObject({ type: "staff_data_change", class_id: classF.id, row_id: graderRoleId });
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

test.describe("review assignments follow manage_review_assignments (#1010, step 5)", () => {
  let classG: Awaited<ReturnType<typeof createClass>>;
  let instructorG: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;

  test.beforeAll(async () => {
    classG = await createClass({ name: "E2E Review Assignments G" });
    instructorG = await createUserInClass({ role: "instructor", class_id: classG.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classG.id });
    headTa = await createUserInClass({ role: "grader", class_id: classG.id });
    assignment = await insertAssignment({
      class_id: classG.id,
      due_date: addDays(new Date(), 14).toISOString(),
      assignment_slug: `e2e-review-g-${Date.now().toString(36)}`
    });

    const { data: headTaRole, error } = await supabase
      .from("class_roles")
      .insert({ class_id: classG.id, name: "Head TA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .insert({ role_id: headTaRole!.id, capability: "manage_review_assignments" })
      ).error
    ).toBeNull();
    const row = await userRole(headTa);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: headTaRole!.id }).eq("id", row.id)).error
    ).toBeNull();
  });

  /**
   * A submission by a new student. A person can have only one review assignment per submission
   * review, and a student's submissions share one, so each review assignment gets its own student.
   */
  async function newSubmission() {
    const student = await createUserInClass({ role: "student", class_id: classG.id });
    return insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classG.id
    });
  }

  async function reviewAssignmentFor(assignee: TestingUser) {
    const submission = await newSubmission();
    const { data, error } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: assignee.private_profile_id,
        class_id: classG.id,
        assignment_id: assignment.id,
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        rubric_id: assignment.grading_rubric_id!,
        due_date: addDays(new Date(), 1).toISOString()
      })
      .select("id, due_date")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function reviewAssignmentExists(id: number) {
    const { data, error } = await supabase.from("review_assignments").select("id").eq("id", id);
    expect(error).toBeNull();
    return (data ?? []).length === 1;
  }

  async function visibleIds(user: TestingUser) {
    const client = await createAuthenticatedClient(user);
    const { data, error } = await client.from("review_assignments").select("id").eq("class_id", classG.id);
    expect(error).toBeNull();
    return (data ?? []).map((ra) => ra.id).sort((a, b) => a - b);
  }

  test("an instructor sees and deletes any review assignment in the class", async () => {
    const forGrader = await reviewAssignmentFor(plainGrader);
    const forHeadTa = await reviewAssignmentFor(headTa);
    expect(await visibleIds(instructorG)).toEqual(expect.arrayContaining([forGrader.id, forHeadTa.id]));

    const instructor = await createAuthenticatedClient(instructorG);
    const { data, error } = await instructor.from("review_assignments").delete().eq("id", forGrader.id).select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(await reviewAssignmentExists(forGrader.id)).toBe(false);
  });

  test("a default grader sees only their own review assignments and can't delete any", async () => {
    const own = await reviewAssignmentFor(plainGrader);
    const other = await reviewAssignmentFor(instructorG);
    const visible = await visibleIds(plainGrader);
    expect(visible).toContain(own.id);
    expect(visible).not.toContain(other.id);

    const grader = await createAuthenticatedClient(plainGrader);
    for (const id of [own.id, other.id]) {
      expectBlocked(
        await grader.from("review_assignments").delete().eq("id", id).select("id"),
        "a default grader deleting a review assignment"
      );
      expect(await reviewAssignmentExists(id), "the review assignment is still there").toBe(true);
    }
  });

  test("a grader on a custom role with manage_review_assignments sees and deletes the class's review assignments", async () => {
    const other = await reviewAssignmentFor(plainGrader);
    expect(await visibleIds(headTa)).toContain(other.id);

    const client = await createAuthenticatedClient(headTa);
    const { data, error } = await client.from("review_assignments").delete().eq("id", other.id).select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(await reviewAssignmentExists(other.id)).toBe(false);
  });

  test("that grader still can't create or edit review assignments", async () => {
    const client = await createAuthenticatedClient(headTa);
    const submission = await newSubmission();
    const { error: insertError } = await client.from("review_assignments").insert({
      assignee_profile_id: plainGrader.private_profile_id,
      class_id: classG.id,
      assignment_id: assignment.id,
      submission_id: submission.submission_id,
      submission_review_id: submission.grading_review_id,
      rubric_id: assignment.grading_rubric_id!,
      due_date: addDays(new Date(), 1).toISOString()
    });
    expect(insertError, "creating a review assignment stays instructor-only").not.toBeNull();

    const existing = await reviewAssignmentFor(plainGrader);
    expectBlocked(
      await client
        .from("review_assignments")
        .update({ due_date: addDays(new Date(), 7).toISOString() })
        .eq("id", existing.id)
        .select("id"),
      "a Head TA editing a review assignment"
    );
    const { data: after, error } = await supabase
      .from("review_assignments")
      .select("due_date")
      .eq("id", existing.id)
      .single();
    expect(error).toBeNull();
    expect(after!.due_date, "the due date is unchanged").toBe(existing.due_date);
  });
  /** A rubric part of `rubric_id`, marked as covered by `review_assignment_id`, made with the service client. */
  async function rubricPartFor(
    review_assignment_id: number,
    class_id: number,
    a: { id: number; grading_rubric_id: number | null }
  ) {
    const { data: part, error: partError } = await supabase
      .from("rubric_parts")
      .insert({ class_id, rubric_id: a.grading_rubric_id!, assignment_id: a.id, name: "Part A", ordinal: 1 })
      .select("id")
      .single();
    expect(partError).toBeNull();
    const { error } = await supabase
      .from("review_assignment_rubric_parts")
      .insert({ review_assignment_id, rubric_part_id: part!.id, class_id });
    expect(error).toBeNull();
    return part!.id;
  }

  async function visibleRubricParts(user: TestingUser, review_assignment_id: number) {
    const client = await createAuthenticatedClient(user);
    const { data, error } = await client
      .from("review_assignment_rubric_parts")
      .select("rubric_part_id")
      .eq("review_assignment_id", review_assignment_id);
    expect(error).toBeNull();
    return (data ?? []).map((rp) => rp.rubric_part_id);
  }

  test("a grader with manage_review_assignments reads the rubric parts of other graders' reviews", async () => {
    // Manage Review Assignments reads these to show each review's Rubric Part and coverage.
    const review = await reviewAssignmentFor(instructorG);
    const partId = await rubricPartFor(review.id, classG.id, assignment);
    expect(await visibleRubricParts(headTa, review.id)).toEqual([partId]);
    expect(await visibleRubricParts(plainGrader, review.id), "a default grader still can't").toEqual([]);
  });

  test("manage_review_assignments in one class doesn't reach another class", async () => {
    const otherClass = await createClass({ name: "E2E Review Assignments Other" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const otherStudent = await createUserInClass({ role: "student", class_id: otherClass.id });
    const otherAssignment = await insertAssignment({
      class_id: otherClass.id,
      due_date: addDays(new Date(), 14).toISOString(),
      assignment_slug: `e2e-review-other-${Date.now().toString(36)}`
    });
    const submission = await insertPreBakedSubmission({
      student_profile_id: otherStudent.private_profile_id,
      assignment_id: otherAssignment.id,
      class_id: otherClass.id
    });
    const { data: review, error } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: otherInstructor.private_profile_id,
        class_id: otherClass.id,
        assignment_id: otherAssignment.id,
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        rubric_id: otherAssignment.grading_rubric_id!,
        due_date: addDays(new Date(), 1).toISOString()
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    await rubricPartFor(review!.id, otherClass.id, otherAssignment);

    const client = await createAuthenticatedClient(headTa);
    const { data: reviews } = await client.from("review_assignments").select("id").eq("id", review!.id);
    expect(reviews ?? [], "the other class's review assignment").toHaveLength(0);
    expect(await visibleRubricParts(headTa, review!.id), "the other class's rubric parts").toEqual([]);
  });
});

test.describe("flashcard decks follow manage_flashcards (#1010, area 13)", () => {
  let classH: Awaited<ReturnType<typeof createClass>>;
  let instructorH: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let withoutCap: TestingUser;
  let withCapRoleId: number;
  let withoutCapRoleId: number;

  test.beforeAll(async () => {
    classH = await createClass({ name: "E2E Flashcards H" });
    instructorH = await createUserInClass({ role: "instructor", class_id: classH.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classH.id });
    headTa = await createUserInClass({ role: "grader", class_id: classH.id });
    withoutCap = await createUserInClass({ role: "grader", class_id: classH.id });

    const { data: withCapRole, error: withError } = await supabase
      .from("class_roles")
      .insert({ class_id: classH.id, name: "Flashcard TA" })
      .select("id")
      .single();
    expect(withError).toBeNull();
    withCapRoleId = withCapRole!.id;
    // Copied from the default grader role, so it already has grader-seeded capabilities.
    expect(await roleCapabilities(withCapRoleId)).toEqual(GRADER_SEEDED_CAPABILITIES);
    const headTaRow = await userRole(headTa);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withCapRoleId }).eq("id", headTaRow.id)).error
    ).toBeNull();

    const { data: withoutRole, error: withoutError } = await supabase
      .from("class_roles")
      .insert({ class_id: classH.id, name: "No Flashcards TA" })
      .select("id")
      .single();
    expect(withoutError).toBeNull();
    withoutCapRoleId = withoutRole!.id;
    const { data: removed, error: removeError } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", withoutCapRoleId)
      .eq("capability", "manage_flashcards")
      .select("capability");
    expect(removeError).toBeNull();
    expect(removed, "manage_flashcards turned off").toHaveLength(1);
    const withoutRow = await userRole(withoutCap);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withoutCapRoleId }).eq("id", withoutRow.id)).error
    ).toBeNull();
  });

  async function deckFor(creator: TestingUser, name: string) {
    const { data, error } = await supabase
      .from("flashcard_decks")
      .insert({
        class_id: classH.id,
        creator_id: creator.user_id,
        name,
        description: "e2e deck"
      })
      .select("id, name")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function cardFor(deck_id: number, title: string) {
    const { data, error } = await supabase
      .from("flashcards")
      .insert({
        class_id: classH.id,
        deck_id,
        title,
        prompt: "prompt",
        answer: "answer",
        order: 1
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function deckExists(id: number) {
    const { data, error } = await supabase.from("flashcard_decks").select("id").eq("id", id);
    expect(error).toBeNull();
    return (data ?? []).length === 1;
  }

  test("an instructor creates, edits and deletes flashcard decks and cards", async () => {
    const instructor = await createAuthenticatedClient(instructorH);
    const { data: deck, error: createError } = await instructor
      .from("flashcard_decks")
      .insert({
        class_id: classH.id,
        creator_id: instructorH.user_id,
        name: "Instructor deck",
        description: "by instructor"
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: updated, error: updateError } = await instructor
      .from("flashcard_decks")
      .update({ description: "edited" })
      .eq("id", deck!.id)
      .select("description");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ description: "edited" }]);

    const { data: card, error: cardError } = await instructor
      .from("flashcards")
      .insert({
        class_id: classH.id,
        deck_id: deck!.id,
        title: "Card 1",
        prompt: "p",
        answer: "a",
        order: 1
      })
      .select("id")
      .single();
    expect(cardError).toBeNull();

    const { data: deletedCard, error: deleteCardError } = await instructor
      .from("flashcards")
      .delete()
      .eq("id", card!.id)
      .select("id");
    expect(deleteCardError).toBeNull();
    expect(deletedCard).toHaveLength(1);

    const { data: deleted, error: deleteError } = await instructor
      .from("flashcard_decks")
      .delete()
      .eq("id", deck!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
    expect(await deckExists(deck!.id)).toBe(false);
  });

  test("a default grader still creates, edits and deletes flashcard decks", async () => {
    const grader = await createAuthenticatedClient(plainGrader);
    const { data: deck, error: createError } = await grader
      .from("flashcard_decks")
      .insert({
        class_id: classH.id,
        creator_id: plainGrader.user_id,
        name: "Default grader deck",
        description: "unchanged day one"
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: updated, error: updateError } = await grader
      .from("flashcard_decks")
      .update({ description: "grader edit" })
      .eq("id", deck!.id)
      .select("description");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ description: "grader edit" }]);

    const { data: deleted, error: deleteError } = await grader
      .from("flashcard_decks")
      .delete()
      .eq("id", deck!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("a grader on a custom role with manage_flashcards creates and deletes decks and cards", async () => {
    const client = await createAuthenticatedClient(headTa);
    const { data: deck, error: createError } = await client
      .from("flashcard_decks")
      .insert({
        class_id: classH.id,
        creator_id: headTa.user_id,
        name: "Head TA deck",
        description: "with capability"
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: card, error: cardError } = await client
      .from("flashcards")
      .insert({
        class_id: classH.id,
        deck_id: deck!.id,
        title: "Head TA card",
        prompt: "p",
        answer: "a",
        order: 1
      })
      .select("id")
      .single();
    expect(cardError).toBeNull();

    const { data: deletedCard, error: deleteCardError } = await client
      .from("flashcards")
      .delete()
      .eq("id", card!.id)
      .select("id");
    expect(deleteCardError).toBeNull();
    expect(deletedCard).toHaveLength(1);

    const { data: deleted, error: deleteError } = await client
      .from("flashcard_decks")
      .delete()
      .eq("id", deck!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("a grader on a custom role with manage_flashcards turned off is refused", async () => {
    const existing = await deckFor(instructorH, "Staff deck for refusal");
    const existingCard = await cardFor(existing.id, "Staff card");
    const client = await createAuthenticatedClient(withoutCap);

    expectRlsBlocked(
      await client.from("flashcard_decks").insert({
        class_id: classH.id,
        creator_id: withoutCap.user_id,
        name: "Should fail",
        description: "no capability"
      }),
      "creating a deck without manage_flashcards"
    );

    expectBlocked(
      await client.from("flashcard_decks").update({ description: "nope" }).eq("id", existing.id).select("id"),
      "editing a deck without manage_flashcards"
    );
    expect(await deckExists(existing.id), "the deck is unchanged").toBe(true);

    expectBlocked(
      await client.from("flashcard_decks").delete().eq("id", existing.id).select("id"),
      "deleting a deck without manage_flashcards"
    );
    expect(await deckExists(existing.id)).toBe(true);

    expectRlsBlocked(
      await client.from("flashcards").insert({
        class_id: classH.id,
        deck_id: existing.id,
        title: "Should fail",
        prompt: "p",
        answer: "a",
        order: 2
      }),
      "creating a card without manage_flashcards"
    );

    expectBlocked(
      await client.from("flashcards").update({ title: "nope" }).eq("id", existingCard.id).select("id"),
      "editing a card without manage_flashcards"
    );

    expectBlocked(
      await client.from("flashcards").delete().eq("id", existingCard.id).select("id"),
      "deleting a card without manage_flashcards"
    );
  });

  test("a grader without manage_flashcards cannot manage a deck they created", async () => {
    // Service role sets creator_id; the old creator OR on UPDATE/DELETE is gone, so capability alone decides.
    const ownDeck = await deckFor(withoutCap, "Creator without capability");
    const ownCard = await cardFor(ownDeck.id, "Creator card");
    const client = await createAuthenticatedClient(withoutCap);

    expectBlocked(
      await client.from("flashcard_decks").update({ description: "creator edit" }).eq("id", ownDeck.id).select("id"),
      "updating own deck without manage_flashcards"
    );
    expectBlocked(
      await client.from("flashcard_decks").delete().eq("id", ownDeck.id).select("id"),
      "deleting own deck without manage_flashcards"
    );
    expect(await deckExists(ownDeck.id)).toBe(true);

    expectRlsBlocked(
      await client.from("flashcards").insert({
        class_id: classH.id,
        deck_id: ownDeck.id,
        title: "Creator insert",
        prompt: "p",
        answer: "a",
        order: 2
      }),
      "inserting a card on own deck without manage_flashcards"
    );
    expectBlocked(
      await client.from("flashcards").update({ title: "creator card edit" }).eq("id", ownCard.id).select("id"),
      "updating a card on own deck without manage_flashcards"
    );
    expectBlocked(
      await client.from("flashcards").delete().eq("id", ownCard.id).select("id"),
      "deleting a card on own deck without manage_flashcards"
    );
  });

  test("a demoted grader loses management of decks they created but can still study them", async () => {
    const creator = await createUserInClass({ role: "grader", class_id: classH.id });
    const asGrader = await createAuthenticatedClient(creator);
    const { data: deck, error: createError } = await asGrader
      .from("flashcard_decks")
      .insert({
        class_id: classH.id,
        creator_id: creator.user_id,
        name: "Created before demotion",
        description: "had capability"
      })
      .select("id")
      .single();
    expect(createError).toBeNull();
    const { data: card, error: cardError } = await asGrader
      .from("flashcards")
      .insert({
        class_id: classH.id,
        deck_id: deck!.id,
        title: "Study card",
        prompt: "p",
        answer: "a",
        order: 1
      })
      .select("id")
      .single();
    expect(cardError).toBeNull();

    const row = await userRole(creator);
    expect((await supabase.from("user_roles").update({ role: "student" }).eq("id", row.id)).error).toBeNull();

    const asStudent = await createAuthenticatedClient(creator);
    const { data: decks, error: readError } = await asStudent.from("flashcard_decks").select("id").eq("id", deck!.id);
    expect(readError).toBeNull();
    expect(decks ?? [], "still reads the deck").toHaveLength(1);
    const { data: cards, error: cardsReadError } = await asStudent.from("flashcards").select("id").eq("id", card!.id);
    expect(cardsReadError).toBeNull();
    expect(cards ?? [], "still reads the card").toHaveLength(1);

    const { error: progressError } = await asStudent.from("student_flashcard_deck_progress").insert({
      student_id: creator.user_id,
      class_id: classH.id,
      card_id: card!.id,
      is_mastered: false
    });
    expect(progressError, "can still study the deck").toBeNull();

    expectBlocked(
      await asStudent.from("flashcard_decks").update({ description: "demoted" }).eq("id", deck!.id).select("id"),
      "demoted creator cannot update deck"
    );
    expectBlocked(
      await asStudent.from("flashcard_decks").delete().eq("id", deck!.id).select("id"),
      "demoted creator cannot delete deck"
    );
    expectRlsBlocked(
      await asStudent.from("flashcards").insert({
        class_id: classH.id,
        deck_id: deck!.id,
        title: "demoted insert",
        prompt: "p",
        answer: "a",
        order: 2
      }),
      "demoted creator cannot insert cards"
    );
    expectBlocked(
      await asStudent.from("flashcards").update({ title: "demoted" }).eq("id", card!.id).select("id"),
      "demoted creator cannot update cards"
    );
    expectBlocked(
      await asStudent.from("flashcards").delete().eq("id", card!.id).select("id"),
      "demoted creator cannot delete cards"
    );
  });

  test("students still read decks and write their own progress", async () => {
    const student = await createUserInClass({ role: "student", class_id: classH.id });
    const deck = await deckFor(instructorH, "Student-visible deck");
    const card = await cardFor(deck.id, "Practice card");
    const client = await createAuthenticatedClient(student);

    const { data: decks, error: readError } = await client.from("flashcard_decks").select("id").eq("id", deck.id);
    expect(readError).toBeNull();
    expect(decks ?? []).toHaveLength(1);

    const { error: progressError } = await client.from("student_flashcard_deck_progress").insert({
      student_id: student.user_id,
      class_id: classH.id,
      card_id: card.id,
      is_mastered: false
    });
    expect(progressError, "students keep writing their own progress").toBeNull();

    expectRlsBlocked(
      await client.from("flashcard_decks").insert({
        class_id: classH.id,
        creator_id: student.user_id,
        name: "Student must not create",
        description: "no"
      }),
      "students still cannot create decks"
    );
  });

  test("a card whose class_id does not match its deck's class is refused", async () => {
    const otherClass = await createClass({ name: "E2E Flashcards Mismatch" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const { data: otherDeck, error } = await supabase
      .from("flashcard_decks")
      .insert({
        class_id: otherClass.id,
        creator_id: otherInstructor.user_id,
        name: "Foreign deck",
        description: "for mismatch"
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    const client = await createAuthenticatedClient(headTa);
    expectRlsBlocked(
      await client.from("flashcards").insert({
        class_id: classH.id,
        deck_id: otherDeck!.id,
        title: "Mismatched class",
        prompt: "p",
        answer: "a",
        order: 1
      }),
      "card class_id must match the deck's class"
    );
  });

  test("moving a deck or card to another class without the capability there is refused", async () => {
    const otherClass = await createClass({ name: "E2E Flashcards Move Target" });
    await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const deck = await deckFor(instructorH, "Move source deck");
    const card = await cardFor(deck.id, "Move source card");
    const client = await createAuthenticatedClient(headTa);

    expectBlocked(
      await client.from("flashcard_decks").update({ class_id: otherClass.id }).eq("id", deck.id).select("id"),
      "moving a deck to a class without manage_flashcards"
    );
    expectBlocked(
      await client.from("flashcards").update({ class_id: otherClass.id }).eq("id", card.id).select("id"),
      "moving a card to a class without manage_flashcards"
    );
    const { data: deckRow } = await supabase.from("flashcard_decks").select("class_id").eq("id", deck.id).single();
    expect(deckRow?.class_id).toBe(classH.id);
    const { data: cardRow } = await supabase.from("flashcards").select("class_id").eq("id", card.id).single();
    expect(cardRow?.class_id).toBe(classH.id);
  });

  test("manage_flashcards in one class doesn't reach another class", async () => {
    const otherClass = await createClass({ name: "E2E Flashcards Other" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const { data: otherDeck, error } = await supabase
      .from("flashcard_decks")
      .insert({
        class_id: otherClass.id,
        creator_id: otherInstructor.user_id,
        name: "Other class deck",
        description: "not this class"
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const { data: otherCard, error: otherCardError } = await supabase
      .from("flashcards")
      .insert({
        class_id: otherClass.id,
        deck_id: otherDeck!.id,
        title: "Other class card",
        prompt: "p",
        answer: "a",
        order: 1
      })
      .select("id")
      .single();
    expect(otherCardError).toBeNull();

    const client = await createAuthenticatedClient(headTa);
    expectRlsBlocked(
      await client.from("flashcard_decks").insert({
        class_id: otherClass.id,
        creator_id: headTa.user_id,
        name: "Cross-class insert",
        description: "no"
      }),
      "inserting a deck in another class"
    );
    expectBlocked(
      await client.from("flashcard_decks").update({ description: "cross-class" }).eq("id", otherDeck!.id).select("id"),
      "editing another class's deck"
    );
    expectBlocked(
      await client.from("flashcard_decks").delete().eq("id", otherDeck!.id).select("id"),
      "deleting another class's deck"
    );
    expectRlsBlocked(
      await client.from("flashcards").insert({
        class_id: otherClass.id,
        deck_id: otherDeck!.id,
        title: "Cross-class card",
        prompt: "p",
        answer: "a",
        order: 2
      }),
      "inserting a card in another class"
    );
    expectBlocked(
      await client.from("flashcards").update({ title: "cross" }).eq("id", otherCard!.id).select("id"),
      "editing another class's card"
    );
    expectBlocked(
      await client.from("flashcards").delete().eq("id", otherCard!.id).select("id"),
      "deleting another class's card"
    );
    const { data: stillThere, error: checkError } = await supabase
      .from("flashcard_decks")
      .select("id")
      .eq("id", otherDeck!.id);
    expect(checkError).toBeNull();
    expect(stillThere ?? []).toHaveLength(1);
  });
});

test.describe("surveys follow manage_surveys (#1010, area 11)", () => {
  let classS: Awaited<ReturnType<typeof createClass>>;
  let instructorS: TestingUser;
  let plainGrader: TestingUser;
  let withCap: TestingUser;
  let withoutCap: TestingUser;
  let withCapRoleId: number;

  const surveyJson = { pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Q1" }] }] };

  test.beforeAll(async () => {
    classS = await createClass({ name: "E2E Surveys S" });
    instructorS = await createUserInClass({ role: "instructor", class_id: classS.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classS.id });
    withCap = await createUserInClass({ role: "grader", class_id: classS.id });
    withoutCap = await createUserInClass({ role: "grader", class_id: classS.id });

    const { data: withCapRole, error: withError } = await supabase
      .from("class_roles")
      .insert({ class_id: classS.id, name: "Survey TA" })
      .select("id")
      .single();
    expect(withError).toBeNull();
    withCapRoleId = withCapRole!.id;
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: withCapRoleId, capability: "manage_surveys" })).error
    ).toBeNull();
    const withRow = await userRole(withCap);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withCapRoleId }).eq("id", withRow.id)).error
    ).toBeNull();

    const { data: withoutRole, error: withoutError } = await supabase
      .from("class_roles")
      .insert({ class_id: classS.id, name: "No Surveys TA" })
      .select("id")
      .single();
    expect(withoutError).toBeNull();
    const withoutRow = await userRole(withoutCap);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withoutRole!.id }).eq("id", withoutRow.id)).error
    ).toBeNull();
  });

  async function surveyFor(title: string, created_by: string) {
    const { data, error } = await supabase
      .from("surveys")
      .insert({
        class_id: classS.id,
        created_by,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title
      })
      .select("id, survey_id, title, status")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  test("an instructor creates, edits and soft-deletes surveys", async () => {
    const instructor = await createAuthenticatedClient(instructorS);
    const { data: survey, error: createError } = await instructor
      .from("surveys")
      .insert({
        class_id: classS.id,
        created_by: instructorS.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Instructor survey"
      })
      .select("id, survey_id")
      .single();
    expect(createError).toBeNull();

    const { data: updated, error: updateError } = await instructor
      .from("surveys")
      .update({ title: "Instructor survey edited" })
      .eq("id", survey!.id)
      .select("title");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ title: "Instructor survey edited" }]);

    const { error: deleteError } = await instructor.rpc("soft_delete_survey", {
      p_survey_id: survey!.id,
      p_survey_logical_id: survey!.survey_id
    });
    expect(deleteError).toBeNull();
    const { data: after } = await supabase.from("surveys").select("deleted_at").eq("id", survey!.id).single();
    expect(after?.deleted_at).not.toBeNull();
  });

  test("a default grader still cannot manage surveys", async () => {
    const grader = await createAuthenticatedClient(plainGrader);
    expectRlsBlocked(
      await grader.from("surveys").insert({
        class_id: classS.id,
        created_by: plainGrader.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Grader should fail"
      }),
      "default grader creating a survey"
    );
  });

  test("a grader on a custom role with manage_surveys creates and updates surveys", async () => {
    const client = await createAuthenticatedClient(withCap);
    const { data: survey, error: createError } = await client
      .from("surveys")
      .insert({
        class_id: classS.id,
        created_by: withCap.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Head TA survey"
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: updated, error: updateError } = await client
      .from("surveys")
      .update({ title: "Head TA survey edited" })
      .eq("id", survey!.id)
      .select("title");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ title: "Head TA survey edited" }]);
  });

  test("a grader on a custom role without manage_surveys is refused", async () => {
    const existing = await surveyFor("Staff survey for refusal", instructorS.public_profile_id);
    const client = await createAuthenticatedClient(withoutCap);

    expectRlsBlocked(
      await client.from("surveys").insert({
        class_id: classS.id,
        created_by: withoutCap.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Should fail"
      }),
      "creating a survey without manage_surveys"
    );

    const { data: updateData, error: updateError } = await client
      .from("surveys")
      .update({ title: "nope" })
      .eq("id", existing.id)
      .select("id");
    expect(updateError).toBeNull();
    expect(updateData ?? [], "editing a survey without manage_surveys").toHaveLength(0);
    const { data: unchanged } = await supabase.from("surveys").select("title").eq("id", existing.id).single();
    expect(unchanged?.title).toBe(existing.title);

    const { error: softDeleteError } = await client.rpc("soft_delete_survey", {
      p_survey_id: existing.id,
      p_survey_logical_id: existing.survey_id
    });
    expect(softDeleteError?.message ?? "", "soft-deleting without manage_surveys").toMatch(
      /Permission denied: manage_surveys required/
    );
    const { data: stillDraft } = await supabase.from("surveys").select("deleted_at").eq("id", existing.id).single();
    expect(stillDraft?.deleted_at).toBeNull();
  });

  test("a student can still submit a survey response", async () => {
    const student = await createUserInClass({ role: "student", class_id: classS.id });
    const { data: survey, error } = await supabase
      .from("surveys")
      .insert({
        class_id: classS.id,
        created_by: instructorS.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "published",
        title: "Student-visible survey"
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    const client = await createAuthenticatedClient(student);
    const { error: responseError } = await client.from("survey_responses").insert({
      survey_id: survey!.id,
      profile_id: student.private_profile_id,
      response: { q1: "answer" },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });
    expect(responseError, "student can still submit").toBeNull();
  });

  test("manage_surveys in one class doesn't reach another class", async () => {
    const otherClass = await createClass({ name: "E2E Surveys Other" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const otherSurvey = await supabase
      .from("surveys")
      .insert({
        class_id: otherClass.id,
        created_by: otherInstructor.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Other class survey"
      })
      .select("id, title")
      .single();
    expect(otherSurvey.error).toBeNull();

    const client = await createAuthenticatedClient(withCap);
    expectRlsBlocked(
      await client.from("surveys").insert({
        class_id: otherClass.id,
        created_by: withCap.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Cross-class insert"
      }),
      "inserting a survey in another class"
    );
    const { data: crossUpdate, error: crossUpdateError } = await client
      .from("surveys")
      .update({ title: "cross" })
      .eq("id", otherSurvey.data!.id)
      .select("id");
    expect(crossUpdateError).toBeNull();
    expect(crossUpdate ?? [], "editing another class's survey").toHaveLength(0);
    const { data: stillThere } = await supabase.from("surveys").select("title").eq("id", otherSurvey.data!.id).single();
    expect(stillThere?.title).toBe("Other class survey");
  });

  test("a grader with manage_surveys manages assignments for a survey in the same class", async () => {
    const survey = await surveyFor("Assignable survey", instructorS.public_profile_id);
    const student = await createUserInClass({ role: "student", class_id: classS.id });
    const client = await createAuthenticatedClient(withCap);

    const { data: assignment, error: insertError } = await client
      .from("survey_assignments")
      .insert({
        survey_id: survey.id,
        class_id: classS.id,
        profile_id: student.private_profile_id
      })
      .select("id, survey_id")
      .single();
    expect(insertError).toBeNull();

    const { data: updated, error: updateError } = await client
      .from("survey_assignments")
      .update({ profile_id: student.public_profile_id })
      .eq("id", assignment!.id)
      .select("profile_id");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ profile_id: student.public_profile_id }]);

    const { data: deleted, error: deleteError } = await client
      .from("survey_assignments")
      .delete()
      .eq("id", assignment!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("a dual-enrolled grader cannot point a class A assignment at a class B survey", async () => {
    // Same user: manage_surveys in class S, ordinary grader in class B (can read B's rows).
    const classB = await createClass({ name: "E2E Surveys Cross-Assign B" });
    const instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });
    const studentB = await createUserInClass({ role: "student", class_id: classB.id });
    const { data: privB, error: privError } = await supabase
      .from("profiles")
      .insert({ name: "Cross-assign private", class_id: classB.id, is_private_profile: true })
      .select("id")
      .single();
    expect(privError).toBeNull();
    const { data: pubB, error: pubError } = await supabase
      .from("profiles")
      .insert({ name: "Cross-assign public", class_id: classB.id, is_private_profile: false })
      .select("id")
      .single();
    expect(pubError).toBeNull();
    expect(
      (
        await supabase.from("user_roles").insert({
          user_id: withCap.user_id,
          class_id: classB.id,
          private_profile_id: privB!.id,
          public_profile_id: pubB!.id,
          role: "grader"
        })
      ).error
    ).toBeNull();

    const surveyA = await surveyFor("Class A survey for assign", instructorS.public_profile_id);
    const surveyB = (
      await supabase
        .from("surveys")
        .insert({
          class_id: classB.id,
          created_by: instructorB.public_profile_id,
          assigned_to_all: true,
          json: surveyJson,
          version: 1,
          status: "draft",
          title: "Class B survey for assign"
        })
        .select("id")
        .single()
    ).data!;
    expect(surveyB).toBeTruthy();

    const studentA = await createUserInClass({ role: "student", class_id: classS.id });
    const { data: assignmentA, error: seedError } = await supabase
      .from("survey_assignments")
      .insert({
        survey_id: surveyA.id,
        class_id: classS.id,
        profile_id: studentA.private_profile_id
      })
      .select("id, survey_id")
      .single();
    expect(seedError).toBeNull();
    const { data: assignmentB, error: seedBError } = await supabase
      .from("survey_assignments")
      .insert({
        survey_id: surveyB.id,
        class_id: classB.id,
        profile_id: studentB.private_profile_id
      })
      .select("id, survey_id")
      .single();
    expect(seedBError).toBeNull();

    const client = await createAuthenticatedClient(withCap);
    expectRlsBlocked(
      await client.from("survey_assignments").insert({
        survey_id: surveyB.id,
        class_id: classS.id,
        profile_id: studentB.private_profile_id
      }),
      "inserting class_id=A pointing at a B survey"
    );

    // WITH CHECK on a row the caller can see raises 42501; the survey_id must stay unchanged.
    const retarget = await client
      .from("survey_assignments")
      .update({ survey_id: surveyB.id })
      .eq("id", assignmentA!.id)
      .select("id");
    expect((retarget.error as { code?: string } | null)?.code, "retargeting an A assignment to a B survey").toBe(
      "42501"
    );
    const { data: stillA } = await supabase
      .from("survey_assignments")
      .select("survey_id")
      .eq("id", assignmentA!.id)
      .single();
    expect(stillA?.survey_id).toBe(surveyA.id);

    expectRlsBlocked(
      await client.from("survey_assignments").insert({
        survey_id: surveyB.id,
        class_id: classB.id,
        profile_id: studentB.public_profile_id
      }),
      "writing a B assignment without manage_surveys in B"
    );
    const { data: updateB, error: updateBError } = await client
      .from("survey_assignments")
      .update({ profile_id: studentB.public_profile_id })
      .eq("id", assignmentB!.id)
      .select("id");
    expect(updateBError).toBeNull();
    expect(updateB ?? [], "updating a B assignment without manage_surveys in B").toHaveLength(0);
    const { data: deleteB, error: deleteBError } = await client
      .from("survey_assignments")
      .delete()
      .eq("id", assignmentB!.id)
      .select("id");
    expect(deleteBError).toBeNull();
    expect(deleteB ?? [], "deleting a B assignment without manage_surveys in B").toHaveLength(0);
    const { data: stillB } = await supabase.from("survey_assignments").select("id").eq("id", assignmentB!.id);
    expect(stillB ?? []).toHaveLength(1);
  });

  test("can_manage_survey_in_class returns true only for manage_surveys holders on matching surveys", async () => {
    const classB = await createClass({ name: "E2E Surveys Helper B" });
    const instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });
    const studentB = await createUserInClass({ role: "student", class_id: classB.id });

    const surveyA = await surveyFor("Helper class A survey", instructorS.public_profile_id);
    const { data: surveyB, error: surveyBError } = await supabase
      .from("surveys")
      .insert({
        class_id: classB.id,
        created_by: instructorB.public_profile_id,
        assigned_to_all: true,
        json: surveyJson,
        version: 1,
        status: "draft",
        title: "Helper class B survey"
      })
      .select("id")
      .single();
    expect(surveyBError).toBeNull();

    const studentClient = await createAuthenticatedClient(studentB);
    const { data: studentSeesA, error: studentError } = await studentClient.rpc("can_manage_survey_in_class", {
      p_survey_id: surveyA.id,
      p_class_id: classS.id
    });
    expect(studentError).toBeNull();
    expect(studentSeesA, "student of B must not learn that an A survey belongs to A").toBe(false);

    const manager = await createAuthenticatedClient(withCap);
    const { data: managerSeesA, error: managerAError } = await manager.rpc("can_manage_survey_in_class", {
      p_survey_id: surveyA.id,
      p_class_id: classS.id
    });
    expect(managerAError).toBeNull();
    expect(managerSeesA).toBe(true);

    const { data: managerSeesBAsA, error: managerBError } = await manager.rpc("can_manage_survey_in_class", {
      p_survey_id: surveyB!.id,
      p_class_id: classS.id
    });
    expect(managerBError).toBeNull();
    expect(managerSeesBAsA, "A manager must not treat a B survey as belonging to A").toBe(false);
  });

  test("survey templates and series follow manage_surveys; template delete stays creator-only", async () => {
    const client = await createAuthenticatedClient(withCap);
    const without = await createAuthenticatedClient(withoutCap);

    const { data: template, error: createTemplateError } = await client
      .from("survey_templates")
      .insert({
        class_id: classS.id,
        created_by: withCap.private_profile_id,
        title: "With-cap template",
        description: "owned by withCap",
        template: surveyJson
      })
      .select("id, title")
      .single();
    expect(createTemplateError).toBeNull();

    const { data: updatedTemplate, error: updateTemplateError } = await client
      .from("survey_templates")
      .update({ title: "With-cap template edited" })
      .eq("id", template!.id)
      .select("title");
    expect(updateTemplateError).toBeNull();
    expect(updatedTemplate).toEqual([{ title: "With-cap template edited" }]);

    expectRlsBlocked(
      await without.from("survey_templates").insert({
        class_id: classS.id,
        created_by: withoutCap.private_profile_id,
        title: "No-cap template",
        description: "should fail",
        template: surveyJson
      }),
      "creating a template without manage_surveys"
    );
    const { data: refusedUpdate, error: refusedUpdateError } = await without
      .from("survey_templates")
      .update({ title: "nope" })
      .eq("id", template!.id)
      .select("id");
    expect(refusedUpdateError).toBeNull();
    expect(refusedUpdate ?? [], "updating a template without manage_surveys").toHaveLength(0);

    const { data: othersTemplate, error: othersError } = await supabase
      .from("survey_templates")
      .insert({
        class_id: classS.id,
        created_by: instructorS.private_profile_id,
        title: "Instructor template",
        description: "not owned by withCap",
        template: surveyJson
      })
      .select("id")
      .single();
    expect(othersError).toBeNull();
    const { data: nonCreatorDelete, error: nonCreatorDeleteError } = await client
      .from("survey_templates")
      .delete()
      .eq("id", othersTemplate!.id)
      .select("id");
    expect(nonCreatorDeleteError).toBeNull();
    expect(nonCreatorDelete ?? [], "deleting someone else's template with manage_surveys").toHaveLength(0);
    const { data: stillOthers } = await supabase.from("survey_templates").select("id").eq("id", othersTemplate!.id);
    expect(stillOthers ?? []).toHaveLength(1);

    const { data: ownDelete, error: ownDeleteError } = await client
      .from("survey_templates")
      .delete()
      .eq("id", template!.id)
      .select("id");
    expect(ownDeleteError).toBeNull();
    expect(ownDelete).toHaveLength(1);

    const { data: series, error: createSeriesError } = await client
      .from("survey_series")
      .insert({
        class_id: classS.id,
        name: "With-cap series",
        created_by: withCap.private_profile_id
      })
      .select("id, name")
      .single();
    expect(createSeriesError).toBeNull();
    const { data: updatedSeries, error: updateSeriesError } = await client
      .from("survey_series")
      .update({ name: "With-cap series edited" })
      .eq("id", series!.id)
      .select("name");
    expect(updateSeriesError).toBeNull();
    expect(updatedSeries).toEqual([{ name: "With-cap series edited" }]);

    expectRlsBlocked(
      await without.from("survey_series").insert({
        class_id: classS.id,
        name: "No-cap series",
        created_by: withoutCap.private_profile_id
      }),
      "creating a series without manage_surveys"
    );
  });

  test("management RPCs require manage_surveys and raise the specific error", async () => {
    const survey = await surveyFor("RPC survey", instructorS.public_profile_id);
    const student = await createUserInClass({ role: "student", class_id: classS.id });
    const withClient = await createAuthenticatedClient(withCap);
    const withoutClient = await createAuthenticatedClient(withoutCap);

    const { error: assignOk } = await withClient.rpc("create_survey_assignments", {
      p_survey_id: survey.id,
      p_profile_ids: [student.private_profile_id]
    });
    expect(assignOk).toBeNull();

    const { error: assignDenied } = await withoutClient.rpc("create_survey_assignments", {
      p_survey_id: survey.id,
      p_profile_ids: [student.private_profile_id]
    });
    expect(assignDenied?.message ?? "").toMatch(/Permission denied: manage_surveys required/);

    const { data: series, error: seriesError } = await supabase
      .from("survey_series")
      .insert({
        class_id: classS.id,
        name: "RPC series",
        created_by: instructorS.private_profile_id
      })
      .select("id")
      .single();
    expect(seriesError).toBeNull();
    expect(
      (await supabase.from("surveys").update({ series_id: series!.id, series_ordinal: 1 }).eq("id", survey.id)).error
    ).toBeNull();

    const { error: reorderOk } = await withClient.rpc("reorder_surveys_in_series", {
      p_series_id: series!.id,
      p_ordinal_updates: [{ id: survey.id, series_ordinal: 1 }]
    });
    expect(reorderOk).toBeNull();
    const { error: reorderDenied } = await withoutClient.rpc("reorder_surveys_in_series", {
      p_series_id: series!.id,
      p_ordinal_updates: [{ id: survey.id, series_ordinal: 1 }]
    });
    expect(reorderDenied?.message ?? "").toMatch(/Permission denied: manage_surveys required/);

    const { error: softOk } = await withClient.rpc("soft_delete_survey", {
      p_survey_id: survey.id,
      p_survey_logical_id: survey.survey_id
    });
    expect(softOk).toBeNull();
  });
});

test.describe("live polls follow run_polls (#1010, area 11)", () => {
  let classP: Awaited<ReturnType<typeof createClass>>;
  let instructorP: TestingUser;
  let plainGrader: TestingUser;
  let withCap: TestingUser;
  let withoutCap: TestingUser;

  const question = { elements: [{ type: "text", name: "q1", title: "Live?" }] };

  test.beforeAll(async () => {
    classP = await createClass({ name: "E2E Polls P" });
    instructorP = await createUserInClass({ role: "instructor", class_id: classP.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classP.id });
    withCap = await createUserInClass({ role: "grader", class_id: classP.id });
    withoutCap = await createUserInClass({ role: "grader", class_id: classP.id });

    const { data: withCapRole, error: withError } = await supabase
      .from("class_roles")
      .insert({ class_id: classP.id, name: "Poll TA" })
      .select("id")
      .single();
    expect(withError).toBeNull();
    expect(await roleCapabilities(withCapRole!.id)).toEqual(GRADER_SEEDED_CAPABILITIES);
    const withRow = await userRole(withCap);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withCapRole!.id }).eq("id", withRow.id)).error
    ).toBeNull();

    const { data: withoutRole, error: withoutError } = await supabase
      .from("class_roles")
      .insert({ class_id: classP.id, name: "No Polls TA" })
      .select("id")
      .single();
    expect(withoutError).toBeNull();
    const { data: removed, error: removeError } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", withoutRole!.id)
      .eq("capability", "run_polls")
      .select("capability");
    expect(removeError).toBeNull();
    expect(removed, "run_polls turned off").toHaveLength(1);
    const withoutRow = await userRole(withoutCap);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withoutRole!.id }).eq("id", withoutRow.id)).error
    ).toBeNull();
  });

  async function pollFor(created_by: string, is_live = false) {
    const { data, error } = await supabase
      .from("live_polls")
      .insert({
        class_id: classP.id,
        created_by,
        question,
        is_live,
        require_login: true
      })
      .select("id, is_live")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  test("an instructor creates, opens and deletes live polls", async () => {
    const instructor = await createAuthenticatedClient(instructorP);
    const { data: poll, error: createError } = await instructor
      .from("live_polls")
      .insert({
        class_id: classP.id,
        created_by: instructorP.public_profile_id,
        question,
        is_live: false,
        require_login: true
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: updated, error: updateError } = await instructor
      .from("live_polls")
      .update({ is_live: true })
      .eq("id", poll!.id)
      .select("is_live");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ is_live: true }]);

    const { data: deleted, error: deleteError } = await instructor
      .from("live_polls")
      .delete()
      .eq("id", poll!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("a default grader still creates and closes live polls", async () => {
    const grader = await createAuthenticatedClient(plainGrader);
    const { data: poll, error: createError } = await grader
      .from("live_polls")
      .insert({
        class_id: classP.id,
        created_by: plainGrader.public_profile_id,
        question,
        is_live: true,
        require_login: true
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: updated, error: updateError } = await grader
      .from("live_polls")
      .update({ is_live: false })
      .eq("id", poll!.id)
      .select("is_live");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ is_live: false }]);
  });

  test("a grader on a custom role with run_polls creates and deletes polls", async () => {
    const client = await createAuthenticatedClient(withCap);
    const { data: poll, error: createError } = await client
      .from("live_polls")
      .insert({
        class_id: classP.id,
        created_by: withCap.public_profile_id,
        question,
        is_live: false,
        require_login: true
      })
      .select("id")
      .single();
    expect(createError).toBeNull();

    const { data: deleted, error: deleteError } = await client
      .from("live_polls")
      .delete()
      .eq("id", poll!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("a grader on a custom role with run_polls turned off is refused", async () => {
    const existing = await pollFor(instructorP.public_profile_id);
    const client = await createAuthenticatedClient(withoutCap);

    expectRlsBlocked(
      await client.from("live_polls").insert({
        class_id: classP.id,
        created_by: withoutCap.public_profile_id,
        question,
        is_live: false,
        require_login: true
      }),
      "creating a poll without run_polls"
    );

    const { data: opened, error: openError } = await client
      .from("live_polls")
      .update({ is_live: true })
      .eq("id", existing.id)
      .select("id");
    expect(openError).toBeNull();
    expect(opened ?? [], "opening a poll without run_polls").toHaveLength(0);
    const { data: unchanged } = await supabase.from("live_polls").select("is_live").eq("id", existing.id).single();
    expect(unchanged?.is_live).toBe(false);

    const { data: deleted, error: deleteError } = await client
      .from("live_polls")
      .delete()
      .eq("id", existing.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted ?? [], "deleting a poll without run_polls").toHaveLength(0);
    const { data: stillThere } = await supabase.from("live_polls").select("id").eq("id", existing.id);
    expect(stillThere ?? []).toHaveLength(1);
  });

  test("a student can still answer a live poll", async () => {
    const student = await createUserInClass({ role: "student", class_id: classP.id });
    const poll = await pollFor(instructorP.public_profile_id, true);
    const client = await createAuthenticatedClient(student);
    const { error } = await client.from("live_poll_responses").insert({
      live_poll_id: poll.id,
      public_profile_id: student.public_profile_id,
      response: { q1: "yes" },
      is_submitted: true
    });
    expect(error, "student can still answer a live poll").toBeNull();
  });

  test("a grader without run_polls can read live poll responses but cannot change them", async () => {
    const student = await createUserInClass({ role: "student", class_id: classP.id });
    const poll = await pollFor(instructorP.public_profile_id, true);
    const { data: response, error: seedError } = await supabase
      .from("live_poll_responses")
      .insert({
        live_poll_id: poll.id,
        public_profile_id: student.public_profile_id,
        response: { q1: "seed" },
        is_submitted: true
      })
      .select("id, response")
      .single();
    expect(seedError).toBeNull();

    const client = await createAuthenticatedClient(withoutCap);
    const { data: visible, error: readError } = await client
      .from("live_poll_responses")
      .select("id, response")
      .eq("id", response!.id);
    expect(readError).toBeNull();
    expect(visible ?? []).toHaveLength(1);

    const { data: updated, error: updateError } = await client
      .from("live_poll_responses")
      .update({ response: { q1: "changed" } })
      .eq("id", response!.id)
      .select("id");
    expect(updateError).toBeNull();
    expect(updated ?? [], "updating a response without run_polls").toHaveLength(0);
    const { data: unchanged } = await supabase
      .from("live_poll_responses")
      .select("response")
      .eq("id", response!.id)
      .single();
    expect(unchanged?.response).toEqual({ q1: "seed" });

    const { data: deleted, error: deleteError } = await client
      .from("live_poll_responses")
      .delete()
      .eq("id", response!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted ?? [], "deleting a response without run_polls").toHaveLength(0);
    const { data: stillThere } = await supabase.from("live_poll_responses").select("id").eq("id", response!.id);
    expect(stillThere ?? []).toHaveLength(1);
  });

  test("run_polls in one class doesn't reach another class", async () => {
    const otherClass = await createClass({ name: "E2E Polls Other" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const { data: otherPoll, error } = await supabase
      .from("live_polls")
      .insert({
        class_id: otherClass.id,
        created_by: otherInstructor.public_profile_id,
        question,
        is_live: false,
        require_login: true
      })
      .select("id, is_live")
      .single();
    expect(error).toBeNull();

    const client = await createAuthenticatedClient(withCap);
    expectRlsBlocked(
      await client.from("live_polls").insert({
        class_id: otherClass.id,
        created_by: withCap.public_profile_id,
        question,
        is_live: false,
        require_login: true
      }),
      "inserting a poll in another class"
    );
    const { data: crossUpdate, error: crossUpdateError } = await client
      .from("live_polls")
      .update({ is_live: true })
      .eq("id", otherPoll!.id)
      .select("id");
    expect(crossUpdateError).toBeNull();
    expect(crossUpdate ?? [], "editing another class's poll").toHaveLength(0);
    const { data: stillThere } = await supabase.from("live_polls").select("is_live").eq("id", otherPoll!.id).single();
    expect(stillThere?.is_live).toBe(false);
  });
});

test.describe("office hours follow help_students and manage_office_hours (#1010, area 10)", () => {
  let classH: Awaited<ReturnType<typeof createClass>>;
  let instructorH: TestingUser;
  let plainGrader: TestingUser;
  let withHelp: TestingUser;
  let withoutHelp: TestingUser;
  let withManage: TestingUser;
  let studentH: TestingUser;
  let queueId: number;
  let withoutHelpRoleId: number;

  test.beforeAll(async () => {
    classH = await createClass({ name: "E2E Office Hours H" });
    instructorH = await createUserInClass({ role: "instructor", class_id: classH.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classH.id });
    withHelp = await createUserInClass({ role: "grader", class_id: classH.id });
    withoutHelp = await createUserInClass({ role: "grader", class_id: classH.id });
    withManage = await createUserInClass({ role: "grader", class_id: classH.id });
    studentH = await createUserInClass({ role: "student", class_id: classH.id });

    const queue = await insertOfficeHoursQueue({ class_id: classH.id, name: "Capability Queue" });
    queueId = queue.id;

    const { data: withHelpRole, error: withHelpError } = await supabase
      .from("class_roles")
      .insert({ class_id: classH.id, name: "Help TA" })
      .select("id")
      .single();
    expect(withHelpError).toBeNull();
    expect(await roleCapabilities(withHelpRole!.id)).toEqual(GRADER_SEEDED_CAPABILITIES);
    const withHelpRow = await userRole(withHelp);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withHelpRole!.id }).eq("id", withHelpRow.id)).error
    ).toBeNull();

    const { data: withoutHelpRole, error: withoutHelpError } = await supabase
      .from("class_roles")
      .insert({ class_id: classH.id, name: "No Help TA" })
      .select("id")
      .single();
    expect(withoutHelpError).toBeNull();
    withoutHelpRoleId = withoutHelpRole!.id;
    const { data: removedHelp, error: removeHelpError } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", withoutHelpRoleId)
      .eq("capability", "help_students")
      .select("capability");
    expect(removeHelpError).toBeNull();
    expect(removedHelp, "help_students turned off").toHaveLength(1);
    const withoutHelpRow = await userRole(withoutHelp);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withoutHelpRoleId }).eq("id", withoutHelpRow.id)).error
    ).toBeNull();

    // manage_office_hours alone (not help_students): prove manager writes without the help capability.
    const { data: withManageRole, error: withManageError } = await supabase
      .from("class_roles")
      .insert({ class_id: classH.id, name: "OH Manager TA" })
      .select("id")
      .single();
    expect(withManageError).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .insert({ role_id: withManageRole!.id, capability: "manage_office_hours" })
      ).error
    ).toBeNull();
    const { data: removedManageHelp, error: removeManageHelpError } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", withManageRole!.id)
      .eq("capability", "help_students")
      .select("capability");
    expect(removeManageHelpError).toBeNull();
    expect(removedManageHelp, "help_students off for manage-only role").toHaveLength(1);
    const withManageRow = await userRole(withManage);
    expect(
      (await supabase.from("user_roles").update({ class_role_id: withManageRole!.id }).eq("id", withManageRow.id)).error
    ).toBeNull();
  });

  async function seedRequest(label: string) {
    return insertHelpRequest({
      class_id: classH.id,
      student_profile_id: studentH.private_profile_id,
      request: label,
      help_queue_id: queueId,
      status: "open",
      active_staff_profile_id: instructorH.private_profile_id
    });
  }

  test("an instructor updates help request status and assignment", async () => {
    const req = await seedRequest("Instructor status");
    const instructor = await createAuthenticatedClient(instructorH);
    const { data: updated, error } = await instructor
      .from("help_requests")
      .update({ status: "in_progress", assignee: instructorH.private_profile_id })
      .eq("id", req.id)
      .select("status, assignee");
    expect(error).toBeNull();
    expect(updated).toEqual([{ status: "in_progress", assignee: instructorH.private_profile_id }]);
  });

  test("a default grader still helps students and manages queues", async () => {
    const req = await seedRequest("Default grader status");
    const grader = await createAuthenticatedClient(plainGrader);
    const { data: updated, error } = await grader
      .from("help_requests")
      .update({ status: "in_progress", assignee: plainGrader.private_profile_id })
      .eq("id", req.id)
      .select("status, assignee");
    expect(error).toBeNull();
    expect(updated).toEqual([{ status: "in_progress", assignee: plainGrader.private_profile_id }]);

    const { data: queue, error: queueError } = await grader
      .from("help_queues")
      .insert({
        class_id: classH.id,
        name: "Grader queue",
        description: "default grader can create",
        depth: 0,
        available: true,
        queue_type: "text"
      })
      .select("id, name")
      .single();
    expect(queueError).toBeNull();
    expect(queue?.name).toBe("Grader queue");
  });

  test("a grader with help_students updates status, posts staff chat, and joins a queue", async () => {
    const req = await seedRequest("Help TA status");
    const client = await createAuthenticatedClient(withHelp);
    const { data: updated, error } = await client
      .from("help_requests")
      .update({ status: "resolved", assignee: withHelp.private_profile_id })
      .eq("id", req.id)
      .select("status, assignee");
    expect(error).toBeNull();
    expect(updated).toEqual([{ status: "resolved", assignee: withHelp.private_profile_id }]);

    const { error: messageError } = await client.from("help_request_messages").insert({
      help_request_id: req.id,
      class_id: classH.id,
      author: withHelp.private_profile_id,
      message: "staff note",
      instructors_only: true
    });
    expect(messageError).toBeNull();

    const { data: assignment, error: assignError } = await client
      .from("help_queue_assignments")
      .insert({
        class_id: classH.id,
        help_queue_id: queueId,
        ta_profile_id: withHelp.private_profile_id,
        is_active: true
      })
      .select("id")
      .single();
    expect(assignError).toBeNull();
    expect(assignment?.id).toBeTruthy();
  });

  test("a grader without help_students is refused for status, chat, queues and assignments", async () => {
    const req = await seedRequest("No-help refusal");
    const client = await createAuthenticatedClient(withoutHelp);

    const { data: statusUpdate, error: statusError } = await client
      .from("help_requests")
      .update({ status: "closed" })
      .eq("id", req.id)
      .select("id");
    expect(statusError).toBeNull();
    expect(statusUpdate ?? [], "updating status without help_students").toHaveLength(0);
    const { data: unchanged } = await supabase.from("help_requests").select("status").eq("id", req.id).single();
    expect(unchanged?.status).toBe("open");

    expectRlsBlocked(
      await client.from("help_request_messages").insert({
        help_request_id: req.id,
        class_id: classH.id,
        author: withoutHelp.private_profile_id,
        message: "should fail",
        instructors_only: true
      }),
      "staff chat without help_students"
    );

    expectRlsBlocked(
      await client.from("help_queues").insert({
        class_id: classH.id,
        name: "Should fail",
        description: "no",
        depth: 0,
        available: true,
        queue_type: "text"
      }),
      "creating a queue without help_students"
    );

    const { data: queueUpdate, error: queueUpdateError } = await client
      .from("help_queues")
      .update({ description: "nope" })
      .eq("id", queueId)
      .select("id");
    expect(queueUpdateError).toBeNull();
    expect(queueUpdate ?? [], "editing a queue without help_students").toHaveLength(0);

    const { data: deletedQueue, error: deleteQueueError } = await client
      .from("help_queues")
      .delete()
      .eq("id", queueId)
      .select("id");
    expect(deleteQueueError).toBeNull();
    expect(deletedQueue ?? [], "deleting a queue without help_students").toHaveLength(0);
    const { data: queueStill } = await supabase.from("help_queues").select("id").eq("id", queueId);
    expect(queueStill ?? []).toHaveLength(1);

    expectRlsBlocked(
      await client.from("help_queue_assignments").insert({
        class_id: classH.id,
        help_queue_id: queueId,
        ta_profile_id: withoutHelp.private_profile_id,
        is_active: true
      }),
      "joining a queue without help_students"
    );
  });

  test("a student can still create a help request", async () => {
    const client = await createAuthenticatedClient(studentH);
    const { data, error } = await client
      .from("help_requests")
      .insert({
        class_id: classH.id,
        help_queue: queueId,
        request: "Student still works",
        created_by: studentH.private_profile_id,
        status: "open",
        is_private: false
      })
      .select("id")
      .single();
    expect(error, "student can still create a help request").toBeNull();
    expect(data?.id).toBeTruthy();
  });

  test("help_students in one class does not reach another class", async () => {
    const otherClass = await createClass({ name: "E2E Office Hours Other" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const otherStudent = await createUserInClass({ role: "student", class_id: otherClass.id });
    const otherQueue = await insertOfficeHoursQueue({ class_id: otherClass.id, name: "Other queue" });
    const otherReq = await insertHelpRequest({
      class_id: otherClass.id,
      student_profile_id: otherStudent.private_profile_id,
      request: "Other class request",
      help_queue_id: otherQueue.id,
      status: "open",
      active_staff_profile_id: otherInstructor.private_profile_id
    });

    // Dual-enrolled: help_students in classH, grader in otherClass on a role without help_students
    // (the default grader role would grant it there too).
    const { data: noHelpRoleB, error: roleBError } = await supabase
      .from("class_roles")
      .insert({ class_id: otherClass.id, name: "No Help Other" })
      .select("id")
      .single();
    expect(roleBError).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", noHelpRoleB!.id)
          .eq("capability", "help_students")
      ).error
    ).toBeNull();

    const { data: privB, error: privError } = await supabase
      .from("profiles")
      .insert({ name: "OH dual private", class_id: otherClass.id, is_private_profile: true })
      .select("id")
      .single();
    expect(privError).toBeNull();
    const { data: pubB, error: pubError } = await supabase
      .from("profiles")
      .insert({ name: "OH dual public", class_id: otherClass.id, is_private_profile: false })
      .select("id")
      .single();
    expect(pubError).toBeNull();
    expect(
      (
        await supabase.from("user_roles").insert({
          user_id: withHelp.user_id,
          class_id: otherClass.id,
          private_profile_id: privB!.id,
          public_profile_id: pubB!.id,
          role: "grader"
        })
      ).error
    ).toBeNull();
    const { data: dualRow, error: dualRowError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", withHelp.user_id)
      .eq("class_id", otherClass.id)
      .single();
    expect(dualRowError).toBeNull();
    expect(
      (await supabase.from("user_roles").update({ class_role_id: noHelpRoleB!.id }).eq("id", dualRow!.id)).error
    ).toBeNull();

    const client = await createAuthenticatedClient(withHelp);
    const { data: crossUpdate, error: crossUpdateError } = await client
      .from("help_requests")
      .update({ status: "closed" })
      .eq("id", otherReq.id)
      .select("id");
    expect(crossUpdateError).toBeNull();
    expect(crossUpdate ?? [], "editing another class help request").toHaveLength(0);
    const { data: stillOpen } = await supabase.from("help_requests").select("status").eq("id", otherReq.id).single();
    expect(stillOpen?.status).toBe("open");

    expectRlsBlocked(
      await client.from("help_queues").insert({
        class_id: otherClass.id,
        name: "Cross-class queue",
        description: "no",
        depth: 0,
        available: true,
        queue_type: "text"
      }),
      "creating a queue in another class without help_students there"
    );
  });

  test("a dual-enrolled grader cannot point a class A queue assignment at a class B queue", async () => {
    const otherClass = await createClass({ name: "E2E OH Cross-Assign B" });
    await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const otherQueue = await insertOfficeHoursQueue({ class_id: otherClass.id, name: "B queue" });

    const { data: privB, error: privError } = await supabase
      .from("profiles")
      .insert({ name: "OH assign private", class_id: otherClass.id, is_private_profile: true })
      .select("id")
      .single();
    expect(privError).toBeNull();
    const { data: pubB, error: pubError } = await supabase
      .from("profiles")
      .insert({ name: "OH assign public", class_id: otherClass.id, is_private_profile: false })
      .select("id")
      .single();
    expect(pubError).toBeNull();
    expect(
      (
        await supabase.from("user_roles").insert({
          user_id: withHelp.user_id,
          class_id: otherClass.id,
          private_profile_id: privB!.id,
          public_profile_id: pubB!.id,
          role: "grader"
        })
      ).error
    ).toBeNull();

    const client = await createAuthenticatedClient(withHelp);
    expectRlsBlocked(
      await client.from("help_queue_assignments").insert({
        class_id: classH.id,
        help_queue_id: otherQueue.id,
        ta_profile_id: withHelp.private_profile_id,
        is_active: true
      }),
      "pointing a class A assignment at a class B queue"
    );
  });

  test("forbid_help_request_privacy_downgrade requires help_students", async () => {
    const { data: privateReq, error } = await supabase
      .from("help_requests")
      .insert({
        class_id: classH.id,
        help_queue: queueId,
        request: "Private for downgrade",
        created_by: studentH.private_profile_id,
        status: "open",
        is_private: true
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(
      (
        await supabase.from("help_request_students").insert({
          help_request_id: privateReq!.id,
          class_id: classH.id,
          profile_id: studentH.private_profile_id
        })
      ).error
    ).toBeNull();

    // The student can see the row (participant UPDATE), but the trigger refuses the
    // private -> public change without help_students.
    const student = await createAuthenticatedClient(studentH);
    const { error: denied } = await student
      .from("help_requests")
      .update({ is_private: false })
      .eq("id", privateReq!.id);
    expect(denied?.message ?? "", "privacy downgrade by a student").toMatch(
      /only course staff may make a private help request public/
    );
    const { data: stillPrivate } = await supabase
      .from("help_requests")
      .select("is_private")
      .eq("id", privateReq!.id)
      .single();
    expect(stillPrivate?.is_private).toBe(true);

    const withClient = await createAuthenticatedClient(withHelp);
    const { data: opened, error: openedError } = await withClient
      .from("help_requests")
      .update({ is_private: false })
      .eq("id", privateReq!.id)
      .select("is_private");
    expect(openedError).toBeNull();
    expect(opened).toEqual([{ is_private: false }]);
  });

  test("manage_office_hours alone gates templates, moderation and work sessions; taking a request is refused", async () => {
    const instructor = await createAuthenticatedClient(instructorH);
    const { data: template, error: createError } = await instructor
      .from("help_request_templates")
      .insert({
        class_id: classH.id,
        name: "Instructor template",
        category: "general",
        template_content: "hello",
        created_by_id: instructorH.private_profile_id
      })
      .select("id, name")
      .single();
    expect(createError).toBeNull();

    const grader = await createAuthenticatedClient(plainGrader);
    expectRlsBlocked(
      await grader.from("help_request_templates").insert({
        class_id: classH.id,
        name: "Grader should fail",
        category: "general",
        template_content: "no",
        created_by_id: plainGrader.private_profile_id
      }),
      "default grader creating a template"
    );

    const manager = await createAuthenticatedClient(withManage);
    const { data: managed, error: managedError } = await manager
      .from("help_request_templates")
      .insert({
        class_id: classH.id,
        name: "Manager template",
        category: "general",
        template_content: "yes",
        created_by_id: withManage.private_profile_id
      })
      .select("id")
      .single();
    expect(managedError).toBeNull();

    const { data: updated, error: updateError } = await manager
      .from("help_request_templates")
      .update({ name: "Manager template edited" })
      .eq("id", managed!.id)
      .select("name");
    expect(updateError).toBeNull();
    expect(updated).toEqual([{ name: "Manager template edited" }]);

    const { data: deletedTemplate, error: deleteTemplateError } = await manager
      .from("help_request_templates")
      .delete()
      .eq("id", managed!.id)
      .select("id");
    expect(deleteTemplateError).toBeNull();
    expect(deletedTemplate ?? []).toHaveLength(1);

    const helper = await createAuthenticatedClient(withHelp);
    const { data: helperUpdate, error: helperUpdateError } = await helper
      .from("help_request_templates")
      .update({ name: "nope" })
      .eq("id", template!.id)
      .select("id");
    expect(helperUpdateError).toBeNull();
    expect(helperUpdate ?? [], "editing a template with only help_students").toHaveLength(0);

    const req = await seedRequest("Manage-only moderation");
    const { data: moderation, error: moderationSeedError } = await supabase
      .from("help_request_moderation")
      .insert({
        class_id: classH.id,
        help_request_id: req.id,
        student_profile_id: studentH.private_profile_id,
        moderator_profile_id: instructorH.private_profile_id,
        action_type: "warning",
        reason: "seed"
      })
      .select("id, reason")
      .single();
    expect(moderationSeedError).toBeNull();

    const { data: modUpdated, error: modUpdateError } = await manager
      .from("help_request_moderation")
      .update({ reason: "manager edited" })
      .eq("id", moderation!.id)
      .select("reason");
    expect(modUpdateError).toBeNull();
    expect(modUpdated).toEqual([{ reason: "manager edited" }]);

    const { data: modDeleted, error: modDeleteError } = await manager
      .from("help_request_moderation")
      .delete()
      .eq("id", moderation!.id)
      .select("id");
    expect(modDeleteError).toBeNull();
    expect(modDeleted ?? []).toHaveLength(1);

    const { data: session, error: sessionSeedError } = await supabase
      .from("help_request_work_sessions")
      .insert({
        class_id: classH.id,
        help_request_id: req.id,
        ta_profile_id: plainGrader.private_profile_id,
        started_at: new Date().toISOString()
      })
      .select("id")
      .single();
    expect(sessionSeedError).toBeNull();

    const { data: sessionDeleted, error: sessionDeleteError } = await manager
      .from("help_request_work_sessions")
      .delete()
      .eq("id", session!.id)
      .select("id");
    expect(sessionDeleteError).toBeNull();
    expect(sessionDeleted ?? [], "deleting someone else's work session with manage_office_hours").toHaveLength(1);

    const { data: takeAttempt, error: takeError } = await manager
      .from("help_requests")
      .update({ status: "in_progress", assignee: withManage.private_profile_id })
      .eq("id", req.id)
      .select("id");
    expect(takeError).toBeNull();
    expect(takeAttempt ?? [], "taking a help request without help_students").toHaveLength(0);
    const { data: stillOpen } = await supabase
      .from("help_requests")
      .select("status, assignee")
      .eq("id", req.id)
      .single();
    expect(stillOpen).toEqual({ status: "open", assignee: null });
  });

  test("a class admin keeps staff chat and private membership writes, not templates", async () => {
    const admin = await createUserInClass({ role: "admin", class_id: classH.id });
    const otherStudent = await createUserInClass({ role: "student", class_id: classH.id });
    const { data: privateReq, error: privateError } = await supabase
      .from("help_requests")
      .insert({
        class_id: classH.id,
        help_queue: queueId,
        request: "Admin private request",
        created_by: studentH.private_profile_id,
        status: "open",
        is_private: true
      })
      .select("id")
      .single();
    expect(privateError).toBeNull();
    expect(
      (
        await supabase.from("help_request_students").insert({
          help_request_id: privateReq!.id,
          class_id: classH.id,
          profile_id: studentH.private_profile_id
        })
      ).error
    ).toBeNull();

    const client = await createAuthenticatedClient(admin);
    const { error: chatError } = await client.from("help_request_messages").insert({
      help_request_id: privateReq!.id,
      class_id: classH.id,
      author: admin.private_profile_id,
      message: "admin staff note",
      instructors_only: true
    });
    expect(chatError, "class admin can post staff chat").toBeNull();

    const { error: memberError } = await client.from("help_request_students").insert({
      help_request_id: privateReq!.id,
      class_id: classH.id,
      profile_id: otherStudent.private_profile_id
    });
    expect(memberError, "class admin can add a member to a private request").toBeNull();

    expectRlsBlocked(
      await client.from("help_request_templates").insert({
        class_id: classH.id,
        name: "Admin should fail",
        category: "general",
        template_content: "no",
        created_by_id: admin.private_profile_id
      }),
      "class admin creating a template"
    );
  });

  test("help_students in A cannot write B messages or attach an A row to a B request", async () => {
    const otherClass = await createClass({ name: "E2E OH Cross-Message B" });
    const otherInstructor = await createUserInClass({ role: "instructor", class_id: otherClass.id });
    const otherStudent = await createUserInClass({ role: "student", class_id: otherClass.id });
    const otherQueue = await insertOfficeHoursQueue({ class_id: otherClass.id, name: "B message queue" });
    const otherReq = await insertHelpRequest({
      class_id: otherClass.id,
      student_profile_id: otherStudent.private_profile_id,
      request: "B request for cross write",
      help_queue_id: otherQueue.id,
      status: "open",
      active_staff_profile_id: otherInstructor.private_profile_id
    });

    const { data: noHelpRoleB, error: roleBError } = await supabase
      .from("class_roles")
      .insert({ class_id: otherClass.id, name: "No Help Cross Msg" })
      .select("id")
      .single();
    expect(roleBError).toBeNull();
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", noHelpRoleB!.id)
          .eq("capability", "help_students")
      ).error
    ).toBeNull();

    const { data: privB, error: privError } = await supabase
      .from("profiles")
      .insert({ name: "OH msg private", class_id: otherClass.id, is_private_profile: true })
      .select("id")
      .single();
    expect(privError).toBeNull();
    const { data: pubB, error: pubError } = await supabase
      .from("profiles")
      .insert({ name: "OH msg public", class_id: otherClass.id, is_private_profile: false })
      .select("id")
      .single();
    expect(pubError).toBeNull();
    expect(
      (
        await supabase.from("user_roles").insert({
          user_id: withHelp.user_id,
          class_id: otherClass.id,
          private_profile_id: privB!.id,
          public_profile_id: pubB!.id,
          role: "grader"
        })
      ).error
    ).toBeNull();
    const { data: dualRow, error: dualRowError } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", withHelp.user_id)
      .eq("class_id", otherClass.id)
      .single();
    expect(dualRowError).toBeNull();
    expect(
      (await supabase.from("user_roles").update({ class_role_id: noHelpRoleB!.id }).eq("id", dualRow!.id)).error
    ).toBeNull();

    const client = await createAuthenticatedClient(withHelp);
    expectRlsBlocked(
      await client.from("help_request_messages").insert({
        help_request_id: otherReq.id,
        class_id: otherClass.id,
        author: privB!.id,
        message: "cross-class staff chat",
        instructors_only: true
      }),
      "staff chat in another class without help_students there"
    );

    // Visible A capability, B help request: WITH CHECK must refuse attaching A class_id to B's id.
    expectRlsBlocked(
      await client.from("help_request_moderation").insert({
        class_id: classH.id,
        help_request_id: otherReq.id,
        student_profile_id: studentH.private_profile_id,
        moderator_profile_id: withHelp.private_profile_id,
        action_type: "warning",
        reason: "cross attach"
      }),
      "attaching a class A moderation row to a class B help request"
    );
  });

  test("private help requests: non-members stay out; owners can still write; staff read needs no help_students", async () => {
    const outsider = await createUserInClass({ role: "student", class_id: classH.id });
    const { data: privateReq, error } = await supabase
      .from("help_requests")
      .insert({
        class_id: classH.id,
        help_queue: queueId,
        request: "Private owner write",
        created_by: studentH.private_profile_id,
        status: "open",
        is_private: true
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(
      (
        await supabase.from("help_request_students").insert({
          help_request_id: privateReq!.id,
          class_id: classH.id,
          profile_id: studentH.private_profile_id
        })
      ).error
    ).toBeNull();

    // Unchanged: a non-member student cannot read a private request.
    const outsiderClient = await createAuthenticatedClient(outsider);
    const { data: hidden, error: hiddenError } = await outsiderClient
      .from("help_requests")
      .select("id")
      .eq("id", privateReq!.id);
    expect(hiddenError).toBeNull();
    expect(hidden ?? [], "non-member student cannot read a private request").toHaveLength(0);

    // Unchanged: authorizeforhelprequeststaff still admits graders without help_students.
    const noHelp = await createAuthenticatedClient(withoutHelp);
    const { data: staffVisible, error: staffVisibleError } = await noHelp
      .from("help_requests")
      .select("id")
      .eq("id", privateReq!.id);
    expect(staffVisibleError).toBeNull();
    expect(staffVisible ?? [], "grader without help_students can still read private requests").toHaveLength(1);

    const owner = await createAuthenticatedClient(studentH);
    const { error: postError } = await owner.from("help_request_messages").insert({
      help_request_id: privateReq!.id,
      class_id: classH.id,
      author: studentH.private_profile_id,
      message: "owner note",
      instructors_only: false
    });
    expect(postError, "owner can post in their private request").toBeNull();

    const { data: ownerUpdate, error: ownerUpdateError } = await owner
      .from("help_requests")
      .update({ request: "Private owner write edited" })
      .eq("id", privateReq!.id)
      .select("request");
    expect(ownerUpdateError).toBeNull();
    expect(ownerUpdate).toEqual([{ request: "Private owner write edited" }]);
  });
});
