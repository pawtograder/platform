/**
 * #1010: Enrollments actions follow manage_roster, for students only
 * (20261122210500_enrollments_by_capability.sql and supabase/functions/enrollments-add).
 *
 * Someone with manage_roster who isn't an instructor (a Head TA here) can remove a student, change a
 * student's SIS sync override, cancel a pending student invitation, and add a student. They can't
 * touch a grader or instructor row, change any role or class_role_id (their own included), change
 * other columns, create invitations, or add a grader or instructor. Instructors are unchanged.
 *
 * A refused update changes 0 rows and returns no error, so those checks read the row back. A change
 * the guard trigger refuses fails with 42501.
 *
 * enrollments-add needs the local Edge Functions (`npx supabase functions serve`). Every email is on
 * @pawtograder.net, so no invitation email is sent.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { randomInt } from "node:crypto";
import { test, expect } from "../global-setup";
import { supabase, createClass, createUserInClass, createAuthenticatedClient, type TestingUser } from "./TestingUtils";

type UserRole = { id: number; role: string; disabled: boolean; sis_sync_opt_out: boolean; class_role_id: number };

test.describe("Enrollments follow manage_roster, students only (#1010)", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let plainGrader: TestingUser;
  let headTa: TestingUser;
  let otherGrader: TestingUser;
  let studentB: TestingUser;
  let headTaRoleId: number;
  let unique = 0;

  async function userRole(user: TestingUser, class_id: number): Promise<UserRole> {
    const { data, error } = await supabase
      .from("user_roles")
      .select("id, role, disabled, sis_sync_opt_out, class_role_id")
      .eq("user_id", user.user_id)
      .eq("class_id", class_id)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function newStudent(class_id = classA.id) {
    return createUserInClass({ role: "student", class_id });
  }

  /** Updates `target`'s user_roles row as `user`; returns the error and how many rows changed. */
  async function updateRoleAs(
    user: TestingUser,
    target: TestingUser,
    class_id: number,
    values: Record<string, unknown>
  ) {
    const client = await createAuthenticatedClient(user);
    const { id } = await userRole(target, class_id);
    const { data, error } = await client.from("user_roles").update(values).eq("id", id).select("id");
    return { error, changed: data?.length ?? 0 };
  }

  /** A pending invitation written as the service role, with its own new profiles. */
  async function serviceInvitation(class_id: number, role: "student" | "grader") {
    unique++;
    const profile = async (is_private_profile: boolean) => {
      const { data, error } = await supabase
        .from("profiles")
        .insert({ name: `E2E invitee ${unique}`, class_id, is_private_profile })
        .select("id")
        .single();
      expect(error).toBeNull();
      return data!.id;
    };
    const { data, error } = await supabase
      .from("invitations")
      .insert({
        class_id,
        role,
        // No user has this SIS id, so the auto-accept trigger leaves the invitation pending.
        sis_user_id: randomInt(900_000_000, 990_000_000),
        name: `E2E invitee ${unique}`,
        public_profile_id: await profile(false),
        private_profile_id: await profile(true)
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function invitationStatus(id: number) {
    const { data, error } = await supabase.from("invitations").select("status").eq("id", id).single();
    expect(error).toBeNull();
    return data!.status;
  }

  async function addMemberAs(user: TestingUser, role: string, email?: string) {
    const client = await createAuthenticatedClient(user);
    const { error } = await client.functions.invoke("enrollments-add", {
      body: {
        courseId: classA.id,
        email: email ?? `e2e-roster-${Date.now().toString(36)}-${++unique}@pawtograder.net`,
        name: "E2E Added Member",
        role,
        notify: false
      }
    });
    const response = (error as { context?: Response } | null)?.context;
    return { error, status: response?.status ?? null };
  }

  test.beforeAll(async () => {
    classA = await createClass({ name: "E2E Enrollments By Capability A" });
    classB = await createClass({ name: "E2E Enrollments By Capability B" });
    instructor = await createUserInClass({ role: "instructor", class_id: classA.id });
    plainGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    headTa = await createUserInClass({ role: "grader", class_id: classA.id });
    otherGrader = await createUserInClass({ role: "grader", class_id: classA.id });
    studentB = await createUserInClass({ role: "student", class_id: classB.id });

    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: classA.id, name: "Roster TA" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    headTaRoleId = role!.id;
    expect(
      (await supabase.from("role_capabilities").insert({ role_id: headTaRoleId, capability: "manage_roster" })).error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: headTaRoleId })
          .eq("user_id", headTa.user_id)
          .eq("class_id", classA.id)
      ).error
    ).toBeNull();
  });

  test("a Head TA can remove a student and change their SIS sync override", async () => {
    const student = await newStudent();
    const sis = await updateRoleAs(headTa, student, classA.id, { sis_sync_opt_out: true });
    expect(sis.error).toBeNull();
    expect(sis.changed).toBe(1);
    const remove = await updateRoleAs(headTa, student, classA.id, { disabled: true });
    expect(remove.error).toBeNull();
    expect(remove.changed).toBe(1);
    const row = await userRole(student, classA.id);
    expect(row.sis_sync_opt_out).toBe(true);
    expect(row.disabled).toBe(true);
  });

  test("a Head TA can't touch a grader's or an instructor's row", async () => {
    for (const target of [otherGrader, instructor]) {
      const before = await userRole(target, classA.id);
      const remove = await updateRoleAs(headTa, target, classA.id, { disabled: true });
      expect(remove.changed).toBe(0);
      const sis = await updateRoleAs(headTa, target, classA.id, { sis_sync_opt_out: true });
      expect(sis.changed).toBe(0);
      expect(await userRole(target, classA.id)).toEqual(before);
    }
  });

  test("a Head TA can't change a student's role, class role or other columns", async () => {
    const student = await newStudent();
    const before = await userRole(student, classA.id);
    const { data: graderRole } = await supabase
      .from("class_roles")
      .select("id")
      .eq("class_id", classA.id)
      .eq("default_for", "grader")
      .single();
    const { data: labSection } = await supabase
      .from("lab_sections")
      .insert({
        class_id: classA.id,
        name: `E2E lab ${++unique}`,
        day_of_week: "monday",
        start_time: "10:00",
        end_time: "11:00"
      })
      .select("id")
      .single();

    for (const values of [
      { role: "grader" },
      { role: "instructor" },
      { class_role_id: graderRole!.id },
      { lab_section_id: labSection!.id },
      { disabled: true, role: "grader" }
    ]) {
      const { error, changed } = await updateRoleAs(headTa, student, classA.id, values);
      expect(error?.code, `${JSON.stringify(values)} must be refused`).toBe("42501");
      expect(changed).toBe(0);
    }
    expect(await userRole(student, classA.id)).toEqual(before);
  });

  test("a Head TA can't change their own role or class role", async () => {
    const before = await userRole(headTa, classA.id);
    for (const values of [{ role: "instructor" }, { class_role_id: before.class_role_id }, { disabled: false }]) {
      const { changed } = await updateRoleAs(headTa, headTa, classA.id, values);
      expect(changed).toBe(0);
    }
    expect(await userRole(headTa, classA.id)).toEqual(before);
  });

  test("a Head TA can cancel a pending student invitation, and nothing else on invitations", async () => {
    const client = await createAuthenticatedClient(headTa);
    const studentInvitation = await serviceInvitation(classA.id, "student");
    const cancel = await client
      .from("invitations")
      .update({ status: "cancelled" })
      .eq("id", studentInvitation)
      .select("id");
    expect(cancel.error).toBeNull();
    expect(cancel.data).toHaveLength(1);
    expect(await invitationStatus(studentInvitation)).toBe("cancelled");

    // Back to pending would run the auto-accept trigger again.
    const reopen = await client.from("invitations").update({ status: "pending" }).eq("id", studentInvitation).select();
    expect(reopen.data ?? []).toHaveLength(0);
    expect(await invitationStatus(studentInvitation)).toBe("cancelled");

    const graderInvitation = await serviceInvitation(classA.id, "grader");
    const cancelGrader = await client
      .from("invitations")
      .update({ status: "cancelled" })
      .eq("id", graderInvitation)
      .select();
    expect(cancelGrader.data ?? []).toHaveLength(0);
    expect(await invitationStatus(graderInvitation)).toBe("pending");

    const other = await serviceInvitation(classA.id, "student");
    const changeEmail = await client
      .from("invitations")
      .update({ status: "cancelled", email: "someone-else@pawtograder.net" })
      .eq("id", other)
      .select();
    expect(changeEmail.error?.code).toBe("42501");
    expect(await invitationStatus(other)).toBe("pending");

    const source = await serviceInvitation(classA.id, "student");
    const { data: profiles } = await supabase
      .from("invitations")
      .select("public_profile_id, private_profile_id")
      .eq("id", source)
      .single();
    const insert = await client.from("invitations").insert({
      class_id: classA.id,
      role: "student",
      sis_user_id: randomInt(980_000_000, 990_000_000),
      public_profile_id: profiles!.public_profile_id,
      private_profile_id: profiles!.private_profile_id
    });
    expect(insert.error?.code, "creating invitations stays instructor-only").toBe("42501");
  });

  test("a Head TA can add a student, but not a grader, an instructor or someone already in the class", async () => {
    const added = await addMemberAs(headTa, "student");
    expect(added.error).toBeNull();

    expect((await addMemberAs(headTa, "grader")).status).toBe(403);
    expect((await addMemberAs(headTa, "instructor")).status).toBe(403);
    expect((await addMemberAs(headTa, "student", otherGrader.email)).status).toBe(403);
    expect((await userRole(otherGrader, classA.id)).role).toBe("grader");
    // Refused before any profile write: the existing person's name is unchanged.
    const { data: profile } = await supabase
      .from("profiles")
      .select("name")
      .eq("id", otherGrader.private_profile_id)
      .single();
    expect(profile!.name).toBe(otherGrader.private_profile_name);
  });

  test("a default grader is refused every Enrollments action", async () => {
    const student = await newStudent();
    expect((await updateRoleAs(plainGrader, student, classA.id, { disabled: true })).changed).toBe(0);
    expect((await updateRoleAs(plainGrader, student, classA.id, { sis_sync_opt_out: true })).changed).toBe(0);
    const row = await userRole(student, classA.id);
    expect(row.disabled).toBe(false);
    expect(row.sis_sync_opt_out).toBe(false);

    const invitation = await serviceInvitation(classA.id, "student");
    const client = await createAuthenticatedClient(plainGrader);
    const cancel = await client.from("invitations").update({ status: "cancelled" }).eq("id", invitation).select();
    expect(cancel.data ?? []).toHaveLength(0);
    expect(await invitationStatus(invitation)).toBe("pending");

    expect((await addMemberAs(plainGrader, "student")).status).toBe(401);
  });

  test("manage_roster in one class doesn't reach another class", async () => {
    expect((await updateRoleAs(headTa, studentB, classB.id, { disabled: true })).changed).toBe(0);
    expect((await userRole(studentB, classB.id)).disabled).toBe(false);
    const invitation = await serviceInvitation(classB.id, "student");
    const client = await createAuthenticatedClient(headTa);
    const cancel = await client.from("invitations").update({ status: "cancelled" }).eq("id", invitation).select();
    expect(cancel.data ?? []).toHaveLength(0);
  });

  test("instructors work as before", async () => {
    const graderSis = await updateRoleAs(instructor, plainGrader, classA.id, { sis_sync_opt_out: true });
    expect(graderSis.error).toBeNull();
    expect(graderSis.changed).toBe(1);

    const student = await newStudent();
    const promote = await updateRoleAs(instructor, student, classA.id, { role: "grader" });
    expect(promote.error).toBeNull();
    expect(promote.changed).toBe(1);

    const invitation = await serviceInvitation(classA.id, "grader");
    const client = await createAuthenticatedClient(instructor);
    const cancel = await client.from("invitations").update({ status: "cancelled" }).eq("id", invitation).select();
    expect(cancel.data).toHaveLength(1);

    expect((await addMemberAs(instructor, "grader")).error).toBeNull();
  });
});
