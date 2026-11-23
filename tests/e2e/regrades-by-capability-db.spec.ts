/**
 * #1010: handling regrade requests follows handle_regrades (20261123040100_regrades_by_capability.sql).
 *
 * Resolving a request and commenting on one as staff need handle_regrades in the request's class.
 * The default instructor and grader roles and every custom role hold it, so nothing changes for them;
 * a custom role that turns it off loses both. Closing an escalated request and editing points stay
 * instructor-only. Every grader and instructor of the class can still read its regrade requests.
 *
 * The migration also closes two holes: staff of another class could read this class's regrade
 * requests (the SELECT policy compared a column to itself), and a comment could be filed under a
 * request from another class (the INSERT policy checked only the class the new row named).
 *
 * Default per-PR lane; lives at tests/e2e/ root so it isn't testIgnore'd.
 */
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createAuthenticatedClient,
  createClass,
  createRegradeRequest,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("regrade requests follow handle_regrades", () => {
  let classA: Awaited<ReturnType<typeof createClass>>;
  let classB: Awaited<ReturnType<typeof createClass>>;
  let instructorA: TestingUser;
  let graderA: TestingUser;
  let headTaA: TestingUser;
  let coordinatorA: TestingUser;
  let studentA: TestingUser;
  let graderB: TestingUser;
  let instructorB: TestingUser;
  let studentB: TestingUser;
  let assignmentId: number;
  let submissionId: number;
  let rubricCheckId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    classA = await createClass({ name: `E2E Regrades A ${suffix}` });
    classB = await createClass({ name: `E2E Regrades B ${suffix}` });
    instructorA = await createUserInClass({ role: "instructor", class_id: classA.id });
    graderA = await createUserInClass({ role: "grader", class_id: classA.id });
    headTaA = await createUserInClass({ role: "grader", class_id: classA.id });
    studentA = await createUserInClass({ role: "student", class_id: classA.id });
    graderB = await createUserInClass({ role: "grader", class_id: classB.id });
    instructorB = await createUserInClass({ role: "instructor", class_id: classB.id });
    studentB = await createUserInClass({ role: "student", class_id: classB.id });

    // The coordinator is a grader in both classes. In B they are on the default grader role, which
    // holds handle_regrades; in A their role turns it off.
    const coordinatorEmail = `regrade-coordinator-${suffix}@pawtograder.net`;
    coordinatorA = await createUserInClass({ role: "grader", class_id: classA.id, email: coordinatorEmail });
    await createUserInClass({ role: "grader", class_id: classB.id, email: coordinatorEmail });

    // Custom roles start as a copy of the default grader role, so both start with handle_regrades.
    const headTaRole = await createRole(classA.id, "Head TA");
    const coordinatorRole = await createRole(classA.id, "Course coordinator");
    expect(
      (
        await supabase
          .from("role_capabilities")
          .delete()
          .eq("role_id", coordinatorRole)
          .eq("capability", "handle_regrades")
      ).error
    ).toBeNull();
    await putOnRole(headTaA, headTaRole);
    await putOnRole(coordinatorA, coordinatorRole);

    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: classA.id,
      name: "Regrades by capability",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });
    assignmentId = assignment.id;
    submissionId = (
      await insertPreBakedSubmission({
        student_profile_id: studentA.private_profile_id,
        assignment_id: assignment.id,
        class_id: classA.id
      })
    ).submission_id;
    const { data: checks, error } = await supabase
      .from("rubric_checks")
      .select("id, rubric_criteria!inner(rubric_id)")
      .eq("rubric_criteria.rubric_id", assignment.grading_rubric_id!)
      .eq("is_annotation", false)
      .order("id", { ascending: true })
      .limit(1);
    expect(error).toBeNull();
    rubricCheckId = checks![0].id;
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

  async function newRequest(status: "opened" | "resolved" | "escalated") {
    return createRegradeRequest(
      submissionId,
      assignmentId,
      studentA.private_profile_id,
      graderA.private_profile_id,
      rubricCheckId,
      classA.id,
      status,
      { initialPoints: 1, resolvedPoints: 2 }
    );
  }

  async function statusOf(requestId: number) {
    const { data, error } = await supabase
      .from("submission_regrade_requests")
      .select("status, resolved_points, closed_points")
      .eq("id", requestId)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function resolveAs(user: TestingUser, requestId: number) {
    const client = await createAuthenticatedClient(user);
    return client.rpc("update_regrade_request_status", {
      regrade_request_id: requestId,
      new_status: "resolved",
      profile_id: user.private_profile_id,
      resolved_points: 3
    });
  }

  function commentRow(
    requestId: number,
    author: string,
    overrides: Partial<{ class_id: number; submission_id: number; assignment_id: number }> = {}
  ) {
    return {
      submission_regrade_request_id: requestId,
      submission_id: submissionId,
      assignment_id: assignmentId,
      class_id: classA.id,
      author,
      comment: `regrade comment ${Math.random().toString(36).slice(2, 8)}`,
      ...overrides
    };
  }

  async function commentsOn(requestId: number) {
    const { data, error } = await supabase
      .from("submission_regrade_request_comments")
      .select("author, class_id")
      .eq("submission_regrade_request_id", requestId);
    expect(error).toBeNull();
    return data ?? [];
  }

  test("default graders, instructors and a custom role with handle_regrades can resolve", async () => {
    for (const [user, who] of [
      [graderA, "a default grader"],
      [instructorA, "an instructor"],
      [headTaA, "a Head TA (custom role)"]
    ] as const) {
      const request = await newRequest("opened");
      const { error } = await resolveAs(user, request.id);
      expect(error, who).toBeNull();
      expect(await statusOf(request.id), who).toMatchObject({ status: "resolved", resolved_points: 3 });
    }
  });

  test("a grader whose role turns handle_regrades off can't resolve, though they hold it in another class", async () => {
    const client = await createAuthenticatedClient(coordinatorA);
    const { data: heldIn, error: heldError } = await client.rpc("user_class_ids_with_capability", {
      p_capability: "handle_regrades"
    });
    expect(heldError).toBeNull();
    expect(heldIn ?? [], "held in class B").toContain(classB.id);
    expect(heldIn ?? [], "not held in class A").not.toContain(classA.id);

    const request = await newRequest("opened");
    const { error } = await resolveAs(coordinatorA, request.id);
    expect(error?.code).toBe("42501");
    expect((await statusOf(request.id)).status).toBe("opened");
  });

  test("closing an escalated request and editing points stay instructor-only", async () => {
    const escalated = await newRequest("escalated");
    for (const user of [graderA, headTaA]) {
      const client = await createAuthenticatedClient(user);
      const { error } = await client.rpc("update_regrade_request_status", {
        regrade_request_id: escalated.id,
        new_status: "closed",
        profile_id: user.private_profile_id,
        closed_points: 5
      });
      expect(error?.message).toContain("Only instructors can close regrade requests");
    }
    expect((await statusOf(escalated.id)).status).toBe("escalated");

    const resolved = await newRequest("resolved");
    const grader = await createAuthenticatedClient(graderA);
    const { error: pointsError } = await grader.rpc("update_regrade_request_points", {
      regrade_request_id: resolved.id,
      profile_id: graderA.private_profile_id,
      resolved_points: 7
    });
    expect(pointsError?.message).toContain("Only instructors can edit regrade request points");
    expect((await statusOf(resolved.id)).resolved_points).toBe(2);

    const instructor = await createAuthenticatedClient(instructorA);
    const { error: closeError } = await instructor.rpc("update_regrade_request_status", {
      regrade_request_id: escalated.id,
      new_status: "closed",
      profile_id: instructorA.private_profile_id,
      closed_points: 5
    });
    expect(closeError).toBeNull();
    const { error: instructorPointsError } = await instructor.rpc("update_regrade_request_points", {
      regrade_request_id: resolved.id,
      profile_id: instructorA.private_profile_id,
      resolved_points: 7
    });
    expect(instructorPointsError).toBeNull();
    expect(await statusOf(escalated.id)).toMatchObject({ status: "closed", closed_points: 5 });
    expect((await statusOf(resolved.id)).resolved_points).toBe(7);
  });

  test("regrade handlers and the submission's student can comment; a role without handle_regrades can't", async () => {
    const request = await newRequest("opened");
    for (const [user, who] of [
      [graderA, "a default grader"],
      [headTaA, "a Head TA"],
      [instructorA, "an instructor"],
      [studentA, "the submission's student"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      const { error } = await client
        .from("submission_regrade_request_comments")
        .insert(commentRow(request.id, user.private_profile_id));
      expect(error, who).toBeNull();
    }

    const coordinator = await createAuthenticatedClient(coordinatorA);
    const { error } = await coordinator
      .from("submission_regrade_request_comments")
      .insert(commentRow(request.id, coordinatorA.private_profile_id));
    expect(error?.code).toBe("42501");

    const authors = (await commentsOn(request.id)).map((c) => c.author);
    expect(authors).toHaveLength(4);
    expect(authors).not.toContain(coordinatorA.private_profile_id);
  });

  test("a grader in another class can't read this class's regrade requests", async () => {
    const request = await newRequest("opened");
    for (const [user, who] of [
      [graderB, "another class's grader"],
      [instructorB, "another class's instructor"],
      [studentB, "another class's student"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      // RLS hides rows instead of raising, so check the error first: a null result from an error must not pass.
      const { data, error } = await client.from("submission_regrade_requests").select("id").eq("id", request.id);
      expect(error, who).toBeNull();
      expect(data ?? [], who).toEqual([]);
    }

    // This class's staff still read it, with or without handle_regrades, and so does the student.
    for (const [user, who] of [
      [graderA, "a default grader"],
      [coordinatorA, "a grader without handle_regrades"],
      [instructorA, "an instructor"],
      [studentA, "the submission's student"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      const { data, error } = await client.from("submission_regrade_requests").select("id").eq("id", request.id);
      expect(error, who).toBeNull();
      expect(data, who).toEqual([{ id: request.id }]);
    }
  });

  test("a comment can't be filed under a request from another class", async () => {
    const request = await newRequest("opened");
    const graderBClient = await createAuthenticatedClient(graderB);

    // Naming their own class, where they hold handle_regrades, on class A's request.
    const { error: ownClassError } = await graderBClient
      .from("submission_regrade_request_comments")
      .insert(commentRow(request.id, graderB.private_profile_id, { class_id: classB.id }));
    expect(ownClassError?.code, "a comment naming class B on class A's request").toBe("42501");

    // Naming class A, where they hold nothing.
    const { error: classAError } = await graderBClient
      .from("submission_regrade_request_comments")
      .insert(commentRow(request.id, graderB.private_profile_id));
    expect(classAError?.code, "a comment naming class A from a class B grader").toBe("42501");

    // The class must match even for someone the rest of the policy lets through: the coordinator
    // holds handle_regrades in class B and can read the request as class A staff, and the student is
    // allowed on their own request. Under the old policy both of these passed.
    for (const [user, who] of [
      [coordinatorA, "a grader naming the class where they hold handle_regrades"],
      [studentA, "the submission's student naming another class"]
    ] as const) {
      const client = await createAuthenticatedClient(user);
      const { error } = await client
        .from("submission_regrade_request_comments")
        .insert(commentRow(request.id, user.private_profile_id, { class_id: classB.id }));
      expect(error?.code, who).toBe("42501");
    }

    expect(await commentsOn(request.id)).toEqual([]);
  });
});
