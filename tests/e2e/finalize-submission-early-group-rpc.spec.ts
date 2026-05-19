import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

type FinalizeSubmissionResponse = {
  success: boolean;
  error?: string;
  message?: string;
};

test.describe.configure({ mode: "serial" });

test.describe("finalize_submission_early RPC for group assignments", () => {
  test.describe.configure({ timeout: 120_000 });

  let classId: number;
  let assignmentId: number;
  let assignmentGroupId: number;
  let studentA: TestingUser;
  let studentB: TestingUser;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Finalize Group RPC ${suffix}` });
    classId = course.id;

    studentA = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Finalize Student A ${suffix}`,
      email: `e2e-finalize-a-${suffix}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Finalize Student B ${suffix}`,
      email: `e2e-finalize-b-${suffix}@pawtograder.net`
    });

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 7).toISOString(),
      name: `E2E Finalize Group Assignment ${suffix}`,
      assignment_slug: `e2e-finalize-group-${suffix}`,
      group_config: "groups",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: addDays(new Date(), 7).toISOString()
    });
    assignmentId = assignment.id;

    const { data: assignmentGroup, error: assignmentGroupError } = await supabase
      .from("assignment_groups")
      .insert({
        assignment_id: assignmentId,
        class_id: classId,
        name: `e2e-finalize-group-${suffix}`
      })
      .select("id")
      .single();
    if (assignmentGroupError || !assignmentGroup) {
      throw new Error(`Failed to create assignment group: ${assignmentGroupError?.message ?? "unknown error"}`);
    }
    assignmentGroupId = assignmentGroup.id;

    const { error: membersError } = await supabase.from("assignment_groups_members").insert([
      {
        assignment_group_id: assignmentGroupId,
        assignment_id: assignmentId,
        class_id: classId,
        added_by: studentA.private_profile_id,
        profile_id: studentA.private_profile_id
      },
      {
        assignment_group_id: assignmentGroupId,
        assignment_id: assignmentId,
        class_id: classId,
        added_by: studentA.private_profile_id,
        profile_id: studentB.private_profile_id
      }
    ]);
    if (membersError) {
      throw new Error(`Failed to add group members: ${membersError.message}`);
    }

    await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      assignment_group_id: assignmentGroupId,
      student_profile_id: studentA.private_profile_id,
      repositorySuffix: suffix
    });
  });

  test("only one group member can successfully finalize early via direct RPC burst", async () => {
    const studentAClient = await createAuthenticatedClient(studentA);
    const studentBClient = await createAuthenticatedClient(studentB);

    const attempts = Array.from({ length: 6 }, (_, idx) =>
      (idx % 2 === 0 ? studentAClient : studentBClient).rpc("finalize_submission_early", {
        this_assignment_id: assignmentId,
        this_profile_id: idx % 2 === 0 ? studentA.private_profile_id : studentB.private_profile_id
      })
    );
    const results = await Promise.all(attempts);
    expect(results.map((result) => result.error).filter(Boolean)).toHaveLength(0);

    const responses: FinalizeSubmissionResponse[] = results.map((result) => result.data as FinalizeSubmissionResponse);
    const successfulResponses = responses.filter((response) => response?.success);
    const failedResponses = responses.filter((response) => !response?.success);

    expect(successfulResponses).toHaveLength(1);
    expect(failedResponses).toHaveLength(responses.length - 1);
    expect(
      failedResponses.every((response) => (response.error ?? response.message) === "Submission already finalized")
    ).toBe(true);

    const { data: exceptions, error: exceptionsError } = await supabase
      .from("assignment_due_date_exceptions")
      .select("id, assignment_group_id, student_id, hours, minutes")
      .eq("assignment_id", assignmentId);

    expect(exceptionsError).toBeNull();
    expect(exceptions).toHaveLength(1);
    expect(exceptions?.[0]?.assignment_group_id).toBe(assignmentGroupId);
    expect(exceptions?.[0]?.student_id).toBeNull();

    const hasPositiveExtension = (exceptions ?? []).some(
      (exception) => exception.hours > 0 || (exception.hours === 0 && exception.minutes > 0)
    );
    expect(hasPositiveExtension).toBe(false);
  });
});
