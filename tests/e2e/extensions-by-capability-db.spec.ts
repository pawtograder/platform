/**
 * #1010: granting due date extensions follows grant_extensions
 * (20261123180200_extensions_by_capability.sql).
 *
 * Adding, editing and deleting a student's extension on one assignment (assignment_due_date_exceptions)
 * and a student's class-wide extension (student_deadline_extensions) need grant_extensions in the row's
 * class. The default instructor and grader roles and every custom role hold it, so nothing changes for
 * them; a custom role that turns it off loses all three. Staff still edit only extensions they created,
 * and only staff with grant_extensions can update an extension. Its assignment, student and group must
 * be in the row's class, so the capability in one class can't reach another. Every grader and instructor of the
 * class can still read extensions, students still use late tokens, and gifting tokens stays
 * instructor-only. Whoever grants an extension, the student's review assignment due dates move with
 * it (#1411).
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
  insertPreBakedSubmission,
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
  let gradingRubricId: number;

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
    gradingRubricId = assignment.grading_rubric_id!;
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

  /** A new student with an unfinished review assignment on the assignment, made with the service client. */
  async function studentWithReviewAssignment() {
    const student = await createUserInClass({ role: "student", class_id: classA.id });
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignmentId,
      class_id: classA.id
    });
    const { data, error } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: student.private_profile_id,
        class_id: classA.id,
        assignment_id: assignmentId,
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        rubric_id: gradingRubricId,
        due_date: addDays(new Date(), 3).toISOString()
      })
      .select("id, due_date")
      .single();
    expect(error).toBeNull();
    return { student, reviewAssignment: data! };
  }

  async function reviewDueDate(id: number) {
    const { data, error } = await supabase.from("review_assignments").select("due_date").eq("id", id).single();
    expect(error).toBeNull();
    return new Date(data!.due_date).getTime();
  }

  test("a review assignment's due date moves with an extension a default grader grants, as it does for an instructor (#1411)", async () => {
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
    for (const [granter, who] of [
      [graderA, "a default grader"],
      [instructorA, "an instructor"]
    ] as const) {
      const { student, reviewAssignment } = await studentWithReviewAssignment();
      const before = new Date(reviewAssignment.due_date).getTime();
      const client = await createAuthenticatedClient(granter);
      const { error } = await client
        .from("assignment_due_date_exceptions")
        .insert({ ...extensionBy(granter, 5), student_id: student.private_profile_id });
      expect(error, who).toBeNull();
      expect((await reviewDueDate(reviewAssignment.id)) - before, who).toBe(FIVE_HOURS_MS);
    }
  });

  test("grant_extensions in class A can't write an extension for a class B assignment, student or group under class A", async () => {
    // Class B's assignment, a class B student with a review assignment on it, and a class B group.
    const assignmentB = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: classB.id,
      name: "Extensions by capability, class B"
    });
    const studentB = await createUserInClass({ role: "student", class_id: classB.id });
    const submissionB = await insertPreBakedSubmission({
      student_profile_id: studentB.private_profile_id,
      assignment_id: assignmentB.id,
      class_id: classB.id
    });
    const { data: reviewAssignmentB, error: reviewAssignmentError } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: studentB.private_profile_id,
        class_id: classB.id,
        assignment_id: assignmentB.id,
        submission_id: submissionB.submission_id,
        submission_review_id: submissionB.grading_review_id,
        rubric_id: assignmentB.grading_rubric_id!,
        due_date: addDays(new Date(), 3).toISOString()
      })
      .select("id, due_date")
      .single();
    expect(reviewAssignmentError).toBeNull();
    const { data: groupB, error: groupError } = await supabase
      .from("assignment_groups")
      .insert({ class_id: classB.id, assignment_id: assignmentB.id, name: `extensions-b-${Date.now()}` })
      .select("id")
      .single();
    expect(groupError).toBeNull();

    const grader = await createAuthenticatedClient(graderA);
    for (const [row, who] of [
      [{ assignment_id: assignmentB.id }, "a class B assignment"],
      [{ student_id: studentB.private_profile_id }, "a class B student"],
      [{ assignment_id: assignmentB.id, student_id: studentB.private_profile_id }, "a class B assignment and student"],
      [{ student_id: null, assignment_group_id: groupB!.id }, "a class B group"]
    ] as const) {
      const { error } = await grader.from("assignment_due_date_exceptions").insert({ ...extensionBy(graderA), ...row });
      expect(error?.code, `a class A grader adding an extension for ${who}`).toBe("42501");
    }
    const { data: written, error: writtenError } = await supabase
      .from("assignment_due_date_exceptions")
      .select("id")
      .or(
        `assignment_id.eq.${assignmentB.id},student_id.eq.${studentB.private_profile_id},assignment_group_id.eq.${groupB!.id}`
      );
    expect(writtenError).toBeNull();
    expect(written, "no extension reaches class B").toEqual([]);
    // Before: the review due date trigger moved class B's review assignment.
    expect(await reviewDueDate(reviewAssignmentB!.id)).toBe(new Date(reviewAssignmentB!.due_date).getTime());

    // Their own class A extension can't be pointed at class B either.
    const own = await seedExtension(graderA, 4);
    for (const [change, who] of [
      [{ assignment_id: assignmentB.id }, "a class B assignment"],
      [{ student_id: studentB.private_profile_id }, "a class B student"]
    ] as const) {
      const { error } = await grader.from("assignment_due_date_exceptions").update(change).eq("id", own);
      expect(error?.code, `a class A grader moving their extension to ${who}`).toBe("42501");
    }
    const { data: unchanged, error: unchangedError } = await supabase
      .from("assignment_due_date_exceptions")
      .select("assignment_id, student_id")
      .eq("id", own)
      .single();
    expect(unchangedError).toBeNull();
    expect(unchanged).toEqual({ assignment_id: assignmentId, student_id: studentA.private_profile_id });

    // A mislabelled row that already exists can't be edited through class A either.
    const { data: mislabelled, error: mislabelledError } = await supabase
      .from("assignment_due_date_exceptions")
      .insert({ ...extensionBy(graderA, 2), assignment_id: assignmentB.id, student_id: studentB.private_profile_id })
      .select("id")
      .single();
    expect(mislabelledError).toBeNull();
    const { data: edited, error: editError } = await grader
      .from("assignment_due_date_exceptions")
      .update({ hours: 40 })
      .eq("id", mislabelled!.id)
      .select("id");
    expect(editError).toBeNull();
    expect(edited, "editing a class A-labelled extension on a class B assignment").toEqual([]);
    expect(await extension(mislabelled!.id)).toEqual({ hours: 2, tokens_consumed: 0 });

    // The in-class paths still work: they edit their own extension.
    const { data: ownEdit, error: ownEditError } = await grader
      .from("assignment_due_date_exceptions")
      .update({ hours: 6 })
      .eq("id", own)
      .select("hours");
    expect(ownEditError).toBeNull();
    expect(ownEdit).toEqual([{ hours: 6 }]);
  });

  test("a student with an unfinished review assignment can spend a late token, and the review's due date moves", async () => {
    const { student, reviewAssignment } = await studentWithReviewAssignment();
    const before = new Date(reviewAssignment.due_date).getTime();
    const client = await createAuthenticatedClient(student);
    const { error } = await client.from("assignment_due_date_exceptions").insert({
      assignment_id: assignmentId,
      student_id: student.private_profile_id,
      class_id: classA.id,
      creator_id: student.private_profile_id,
      hours: 24,
      tokens_consumed: 1
    });
    expect(error, "spending a late token").toBeNull();
    expect((await reviewDueDate(reviewAssignment.id)) - before).toBe(24 * 60 * 60 * 1000);
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
