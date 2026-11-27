/**
 * #1010: the regrade request's Resolve button and staff comment box follow handle_regrades
 * (20261126150300_regrades_by_capability.sql). A grader on the default grader role and an instructor
 * see both. A grader on a custom role that turns handle_regrades off still sees the request, since
 * every staff member of the class can read it, but not Resolve or the comment box.
 *
 * The default instructor and grader roles hold handle_regrades.
 */
import { addDays } from "date-fns";
import { expect, test, type Page } from "@playwright/test";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

const LINE = 2;

test.describe("regrade request controls gated by handle_regrades", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let coordinator: TestingUser;
  let student: TestingUser;
  let assignmentId: number;
  let submissionId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Regrade Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    coordinator = await createUserInClass({ role: "grader", class_id: course.id });
    student = await createUserInClass({ role: "student", class_id: course.id });

    // A custom role starts as a copy of the default grader role; this one turns handle_regrades off.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: "Course coordinator" })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    expect(
      (await supabase.from("role_capabilities").delete().eq("role_id", role!.id).eq("capability", "handle_regrades"))
        .error
    ).toBeNull();
    expect(
      (
        await supabase
          .from("user_roles")
          .update({ class_role_id: role!.id })
          .eq("user_id", coordinator.user_id)
          .eq("class_id", course.id)
      ).error
    ).toBeNull();

    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Regrade gates",
      regrade_deadline: addDays(new Date(), 7).toISOString()
    });
    assignmentId = assignment.id;
    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    submissionId = submission.submission_id;

    // An opened regrade request on a line comment, which the files page shows inline.
    const { data: check, error: checkError } = await supabase
      .from("rubric_checks")
      .select("id, rubric_criteria!inner(rubric_id)")
      .eq("rubric_criteria.rubric_id", assignment.grading_rubric_id!)
      .eq("is_annotation", true)
      .order("id", { ascending: true })
      .limit(1)
      .single();
    expect(checkError).toBeNull();
    const { data: file, error: fileError } = await supabase
      .from("submission_files")
      .select("id")
      .eq("submission_id", submissionId)
      .order("id", { ascending: true })
      .limit(1)
      .single();
    expect(fileError).toBeNull();
    const { data: comment, error: commentError } = await supabase
      .from("submission_file_comments")
      .insert({
        submission_id: submissionId,
        submission_file_id: file!.id,
        author: grader.private_profile_id,
        comment: "Line comment under regrade",
        points: 1,
        line: LINE,
        class_id: course.id,
        released: true,
        rubric_check_id: check!.id,
        submission_review_id: submission.grading_review_id
      })
      .select("id")
      .single();
    expect(commentError).toBeNull();
    const now = new Date().toISOString();
    const { data: request, error: requestError } = await supabase
      .from("submission_regrade_requests")
      .insert({
        submission_id: submissionId,
        class_id: course.id,
        assignment_id: assignmentId,
        created_by: student.private_profile_id,
        assignee: grader.private_profile_id,
        status: "opened",
        opened_at: now,
        submission_file_comment_id: comment!.id,
        initial_points: 1,
        last_updated_at: now
      })
      .select("id")
      .single();
    expect(requestError).toBeNull();
    expect(
      (
        await supabase
          .from("submission_file_comments")
          .update({ regrade_request_id: request!.id })
          .eq("id", comment!.id)
      ).error
    ).toBeNull();
  });

  // useCapability is false while loading, so a hidden control only means "not held" once the answer is in.
  // The page shows the one regrade request both inline in the file and in the rubric sidebar.
  async function expectControls(page: Page, user: TestingUser, visible: boolean) {
    await loginAsUser(page, user, course);
    const capabilities = page.waitForResponse(
      (r) => r.url().includes("/rpc/user_class_capabilities") && r.status() === 200
    );
    await page.goto(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}/files`);
    await capabilities;
    await expect(page.locator("[data-capabilities-loaded]")).toBeAttached({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Regrade Pending" }).first()).toBeVisible({ timeout: 60_000 });
    const resolve = page.getByRole("button", { name: "Resolve Request" });
    const commentBox = page.getByPlaceholder("Add a comment to continue the discussion about this regrade request");
    if (visible) {
      await expect(resolve.first()).toBeVisible();
      await expect(commentBox.first()).toBeVisible();
    } else {
      await expect(resolve).toHaveCount(0);
      await expect(commentBox).toHaveCount(0);
    }
  }

  test("a default grader sees Resolve and the comment box", async ({ page }) => {
    await expectControls(page, grader, true);
  });

  test("an instructor sees Resolve and the comment box", async ({ page }) => {
    await expectControls(page, instructor, true);
  });

  test("a grader whose role turns handle_regrades off sees the request, but not Resolve or the comment box", async ({
    page
  }) => {
    await expectControls(page, coordinator, false);
  });
});
