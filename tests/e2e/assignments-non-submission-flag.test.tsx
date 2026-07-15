import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import type { SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  getTestRunPrefix,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Verifies the roster view's is_non_submission flag distinguishes a graded
// "grade anyway" stub from an earned score.
test.describe("Assignment roster: is_non_submission flag", () => {
  test.describe.configure({ mode: "serial" });

  const runPrefix = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let course: Course;
  let instructor: TestingUser;
  let nonSubmitter: TestingUser;
  let realSubmitter: TestingUser;
  let instructorClient: SupabaseClient<Database>;
  let normalAssignment: Assignment;
  let noSubmissionAssignment: Assignment;

  async function createManualStub(assignment_id: number, profile_id: string): Promise<number> {
    const { data, error } = await instructorClient.rpc("create_manual_submission", {
      p_assignment_id: assignment_id,
      p_profile_id: profile_id
    });
    if (error) throw new Error(`create_manual_submission failed: ${error.message}`);
    return data;
  }

  async function viewFlag(assignmentId: number, studentId: string): Promise<boolean | null> {
    const { data, error } = await supabase
      .from("submissions_with_grades_for_assignment_nice")
      .select("is_non_submission")
      .eq("assignment_id", assignmentId)
      .eq("student_private_profile_id", studentId)
      .single();
    if (error) throw new Error(`Failed to read roster view: ${error.message}`);
    return data.is_non_submission;
  }

  test.beforeAll(async () => {
    course = await createClass({ name: `Roster NonSub ${runPrefix}` });
    [instructor, nonSubmitter, realSubmitter] = await createUsersInClass([
      {
        name: "Roster Instructor",
        public_profile_name: "Roster Pseudonym Instructor",
        email: `roster-instr-${SAFE_ID}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Roster Non Submitter",
        public_profile_name: "Roster Pseudonym Non Submitter",
        email: `roster-nonsub-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Roster Real Submitter",
        public_profile_name: "Roster Pseudonym Real Submitter",
        email: `roster-realsub-${SAFE_ID}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    instructorClient = await createAuthenticatedClient(instructor);

    // Normal assignment: repo_mode defaults to 'template_only_staff' (submission expected).
    normalAssignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toUTCString(),
      release_date: addDays(new Date(), -2).toUTCString(),
      class_id: course.id,
      name: `Roster Normal ${runPrefix}`
    });
    noSubmissionAssignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toUTCString(),
      release_date: addDays(new Date(), -2).toUTCString(),
      class_id: course.id,
      name: `Roster NoSubmission ${runPrefix}`,
      repo_mode: "no_submission"
    });
  });

  test("grade-anyway stub on a normal assignment is flagged is_non_submission", async () => {
    const stubId = await createManualStub(normalAssignment.id, nonSubmitter.private_profile_id);
    const { data: stub } = await supabase
      .from("submissions")
      .select("submitted_via, repository, sha")
      .eq("id", stubId)
      .single();
    expect(stub?.submitted_via).toBe("manual");
    expect(stub?.repository).toBeNull();
    expect(stub?.sha).toBeNull();

    expect(await viewFlag(normalAssignment.id, nonSubmitter.private_profile_id)).toBe(true);
  });

  test("real submission is NOT flagged", async () => {
    await insertPreBakedSubmission({
      student_profile_id: realSubmitter.private_profile_id,
      assignment_id: normalAssignment.id,
      class_id: course.id
    });
    expect(await viewFlag(normalAssignment.id, realSubmitter.private_profile_id)).toBe(false);
  });

  test("stub on a no_submission assignment is NOT flagged (design-normal)", async () => {
    await createManualStub(noSubmissionAssignment.id, nonSubmitter.private_profile_id);
    expect(await viewFlag(noSubmissionAssignment.id, nonSubmitter.private_profile_id)).toBe(false);
  });

  test("a non-submitter with no active submission is NOT flagged (nothing graded yet)", async () => {
    // realSubmitter never submitted the no_submission assignment and has no stub there.
    expect(await viewFlag(noSubmissionAssignment.id, realSubmitter.private_profile_id)).toBe(false);
  });
});
