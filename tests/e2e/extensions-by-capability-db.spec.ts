/**
 * #1010: granting due date extensions follows grant_extensions
 * (20261122150200_extensions_by_capability.sql).
 *
 * Adding, editing and deleting a student's extension on one assignment (assignment_due_date_exceptions)
 * and a student's class-wide extension (student_deadline_extensions) need grant_extensions in the row's
 * class. The default instructor and grader roles and every custom role hold it, so nothing changes for
 * them; a custom role that turns it off loses all three. Staff still edit only extensions they created,
 * and only staff with grant_extensions can update an extension. Every grader and instructor of the
 * class can still read extensions, students still use late tokens, and gifting tokens stays
 * instructor-only.
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("due date extensions follow grant_extensions", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructorA: TestingUser;
  let graderA: TestingUser;
  let headTaA: TestingUser;
  let coordinatorA: TestingUser;
  let studentA: TestingUser;
  let classWideStudentA: TestingUser;
  let graderB: TestingUser;
  let assignmentId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    classA = await createClass({ name: `E2E Extensions A ${suffix}` });
    classB = await createClass({ name: `E2E Extensions B ${suffix}` });
    instructorA = await createUserInClass({ role: "instructor", class_id: classA.id });
    graderA = await createUserInClass({ role: "grader", class_id: classA.id });
    headTaA = await createUserInClass({ role: "grader", class_id: classA.id });
    studentA = await createUserInClass({ role: "student", class_id: classA.id });
    classWideStudentA = await createUserInClass({ role: "student", class_id: classA.id });
    graderB = await createUserInClass({ role: "grader", class_id: classB.id });

    // The coordinator is a grader in both classes. In B they are on the default grader role, which
    // holds grant_extensions; in A their role turns it off.
    const coordinatorEmail = `extension-coordinator-${suffix}@pawtograder.net`;
    coordinatorA = await createUserInClass({ role: "grader", class_id: classA.id, email: coordinatorEmail });
    await createUserInClass({ role: "grader", class_id: classB.id, email: coordinatorEmail });

    // Custom roles start as a copy of the default grader role, so both start with grant_extensions.
    const headTaRole = await createRole(classA.id, "Head TA");
    const coordinatorRole = await createRole(classA.id, "Course coordinator");
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", coordinatorRole)
          .eq("capability", "grant_extensions")
      ).error
    ).toBeNull();
    await putOnRole(headTaA, headTaRole);
    await putOnRole(coordinatorA, coordinatorRole);

    // Students get late tokens to spend (insertAssignment allows 10 per assignment).
    expect(
      (await supabase.from("classes").update({ late_tokens_per_student: 3 }).eq("id", classA.id)).error
    ).toBeNull();
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: classA.id,
      name: "Extensions by capability"
    });
    assignmentId = assignment.id;
  });

  async function createRole(class_id: number, name: string) {
    const { data, error } = await supabase.from("class_roles").insert({ class_id, name }).select("id").single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function putOnRole(user: TestingUser, role_id: number) {
    const { error } = await supabase
      .from("user_roles")
      .update({ class_role_id: role_id })
      .eq("user_id", user.user_id)
      .eq("class_id", user.class_id);
    expect(error).toBeNull();
  }

  function extensionBy(creator: TestingUser, hours = 5) {
    return {
      assignment_id: assignmentId,
      student_id: studentA.private_profile_id,
      class_id: classA.id,
      creator_id: creator.private_profile_id,
      hours,
      minutes: 0,
      tokens_consumed: 0,
      note: "extension test"
    };
  }

  /** An extension made through the service role, as if `creator` had granted it. */
  async function seedExtension(creator: TestingUser, hours = 5) {
    const { data, error } = await supabase
      .from("assignment_due_date_exceptions")
      .insert(extensionBy(creator, hours))
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  async function extension(id: number) {
    const { data, error } = await supabase
      .from("assignment_due_date_exceptions")
      .select("hours, tokens_consumed")
      .eq("id", id)
      .maybeSingle();
    expect(error).toBeNull();
    return data;
  }

  test("default graders, instructors and a custom role with grant_extensions can add and delete an extension", async () => {
    for (const [user, who] of [
      [graderA, "a default grader"],
      [instructorA, "an instructor"],
      [headTaA, "a Head TA (custom role)"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      const { data: added, error: addError } = await client
        .from("assignment_due_date_exceptions")
        .insert(extensionBy(user))
        .select("id")
        .single();
      expect(addError, who).toBeNull();

      const { data: deleted, error: deleteError } = await client
        .from("assignment_due_date_exceptions")
        .delete()
        .eq("id", added!.id)
        .select("id");
      expect(deleteError, who).toBeNull();
      expect(deleted, who).toHaveLength(1);
      expect(await extension(added!.id), who).toBeNull();
    }
  });

  test("a grader whose role turns grant_extensions off can't add, edit or delete one, though they hold it in another class", async () => {
    const coordinator = await createAuthenticatedClient(coordinatorA);
    const { data: heldIn, error: heldError } = await coordinator.rpc("user_class_ids_with_capability", {
      p_capability: "grant_extensions"
    });
    expect(heldError).toBeNull();
    expect(heldIn ?? [], "held in class B").toContain(classB.id);
    expect(heldIn ?? [], "not held in class A").not.toContain(classA.id);

    const { error: addError } = await coordinator
      .from("assignment_due_date_exceptions")
      .insert(extensionBy(coordinatorA))
      .select("id");
    expect(addError?.code).toBe("42501");

    // Their own extension from before the capability was turned off, and a grader's.
    const own = await seedExtension(coordinatorA, 6);
    const others = await seedExtension(graderA, 7);
    const { data: edited, error: editError } = await coordinator
      .from("assignment_due_date_exceptions")
      .update({ hours: 99 })
      .eq("id", own)
      .select("id");
    expect(editError).toBeNull();
    expect(edited, "editing an extension they created").toEqual([]);
    for (const id of [own, others]) {
      const { data: deleted, error: deleteError } = await coordinator
        .from("assignment_due_date_exceptions")
        .delete()
        .eq("id", id)
        .select("id");
      expect(deleteError).toBeNull();
      expect(deleted, "deleting an extension").toEqual([]);
    }
    expect(await extension(own)).toEqual({ hours: 6, tokens_consumed: 0 });
    expect(await extension(others)).toEqual({ hours: 7, tokens_consumed: 0 });

    // A grader of another class can't reach these either.
    const graderBClient = await createAuthenticatedClient(graderB);
    const { data: foreignDelete, error: foreignError } = await graderBClient
      .from("assignment_due_date_exceptions")
      .delete()
      .eq("id", others)
      .select("id");
    expect(foreignError).toBeNull();
    expect(foreignDelete, "another class's grader deleting").toEqual([]);
    expect(await extension(others)).not.toBeNull();
  });

  test("staff still edit only extensions they created", async () => {
    const graderOwn = await seedExtension(graderA, 8);
    const grader = await createAuthenticatedClient(graderA);
    const { data: edited, error } = await grader
      .from("assignment_due_date_exceptions")
      .update({ hours: 9 })
      .eq("id", graderOwn)
      .select("hours");
    expect(error).toBeNull();
    expect(edited, "a grader editing their own extension").toEqual([{ hours: 9 }]);

    for (const [user, who] of [
      [headTaA, "a Head TA editing a grader's extension"],
      [instructorA, "an instructor editing a grader's extension"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      const { data, error: otherError } = await client
        .from("assignment_due_date_exceptions")
        .update({ hours: 50 })
        .eq("id", graderOwn)
        .select("id");
      expect(otherError, who).toBeNull();
      expect(data, who).toEqual([]);
    }
    expect(await extension(graderOwn)).toEqual({ hours: 9, tokens_consumed: 0 });
  });

  test("a student can spend a late token but can't edit the extension it made", async () => {
    const student = await createAuthenticatedClient(studentA);
    const { data: spent, error: spendError } = await student
      .from("assignment_due_date_exceptions")
      .insert({
        assignment_id: assignmentId,
        student_id: studentA.private_profile_id,
        class_id: classA.id,
        creator_id: studentA.private_profile_id,
        hours: 24,
        tokens_consumed: 1
      })
      .select("id")
      .single();
    expect(spendError, "spending a late token").toBeNull();

    const { data: edited, error: editError } = await student
      .from("assignment_due_date_exceptions")
      .update({ hours: 48, tokens_consumed: 1 })
      .eq("id", spent!.id)
      .select("id");
    expect(editError).toBeNull();
    expect(edited, "a student editing their own late-token extension").toEqual([]);
    const { data: deleted, error: deleteError } = await student
      .from("assignment_due_date_exceptions")
      .delete()
      .eq("id", spent!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted, "a student deleting it").toEqual([]);
    expect(await extension(spent!.id)).toEqual({ hours: 24, tokens_consumed: 1 });
  });

  test("class-wide extensions follow grant_extensions, and staff without it still read them", async () => {
    const grader = await createAuthenticatedClient(graderA);
    const { data: added, error: addError } = await grader
      .from("student_deadline_extensions")
      .insert({ class_id: classA.id, student_id: classWideStudentA.private_profile_id, hours: 48 })
      .select("id")
      .single();
    expect(addError, "a default grader adding a class-wide extension").toBeNull();
    // The trigger turns it into an extension on each assignment.
    const { data: applied, error: appliedError } = await supabase
      .from("assignment_due_date_exceptions")
      .select("hours")
      .eq("assignment_id", assignmentId)
      .eq("student_id", classWideStudentA.private_profile_id);
    expect(appliedError).toBeNull();
    expect(applied).toEqual([{ hours: 48 }]);

    const coordinator = await createAuthenticatedClient(coordinatorA);
    const { error: coordinatorAddError } = await coordinator
      .from("student_deadline_extensions")
      .insert({ class_id: classA.id, student_id: studentA.private_profile_id, hours: 12 })
      .select("id");
    expect(coordinatorAddError?.code).toBe("42501");
    const { data: coordinatorEdit, error: coordinatorEditError } = await coordinator
      .from("student_deadline_extensions")
      .update({ hours: 1 })
      .eq("id", added!.id)
      .select("id");
    expect(coordinatorEditError).toBeNull();
    expect(coordinatorEdit, "editing without grant_extensions").toEqual([]);
    const { data: coordinatorDelete, error: coordinatorDeleteError } = await coordinator
      .from("student_deadline_extensions")
      .delete()
      .eq("id", added!.id)
      .select("id");
    expect(coordinatorDeleteError).toBeNull();
    expect(coordinatorDelete, "deleting without grant_extensions").toEqual([]);

    // Reading isn't gated on the capability.
    const { data: read, error: readError } = await coordinator
      .from("student_deadline_extensions")
      .select("id, hours")
      .eq("id", added!.id);
    expect(readError).toBeNull();
    expect(read, "a grader without grant_extensions reads class-wide extensions").toEqual([
      { id: added!.id, hours: 48 }
    ]);
    const { data: readExceptions, error: readExceptionsError } = await coordinator
      .from("assignment_due_date_exceptions")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("student_id", classWideStudentA.private_profile_id);
    expect(readExceptionsError).toBeNull();
    expect(readExceptions ?? [], "and per-assignment extensions").toHaveLength(1);
    const classWideStudent = await createAuthenticatedClient(classWideStudentA);
    const { data: ownRead, error: ownReadError } = await classWideStudent
      .from("student_deadline_extensions")
      .select("id")
      .eq("id", added!.id);
    expect(ownReadError).toBeNull();
    expect(ownRead, "the student reads their own").toEqual([{ id: added!.id }]);

    const { data: edited, error: editError } = await grader
      .from("student_deadline_extensions")
      .update({ hours: 72 })
      .eq("id", added!.id)
      .select("hours");
    expect(editError).toBeNull();
    expect(edited).toEqual([{ hours: 72 }]);
    const { data: deleted, error: deleteError } = await grader
      .from("student_deadline_extensions")
      .delete()
      .eq("id", added!.id)
      .select("id");
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  test("gifting late tokens stays instructor-only", async () => {
    const gift = (client: Awaited<ReturnType<typeof createAuthenticatedClient>>) =>
      client.rpc("gift_tokens_to_student", {
        p_student_id: studentA.private_profile_id,
        p_class_id: classA.id,
        p_assignment_id: assignmentId,
        p_tokens_to_gift: 1
      });
    const { error: graderError } = await gift(await createAuthenticatedClient(graderA));
    expect(graderError?.message).toContain("Only instructors can gift tokens");
    const { data, error } = await gift(await createAuthenticatedClient(instructorA));
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});
