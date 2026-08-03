import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertOfficeHoursQueue,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { assertReflowAt320 } from "./axeStudentA11y";

/**
 * WCAG 1.4.10 (Reflow, Level AA) regression suite: at a 320 CSS-px viewport —
 * the spec's equivalent of a 1280px window at 400% zoom — student pages must
 * not scroll horizontally and must keep all content reachable by vertical
 * scroll (no overflow-hidden shells clipping content).
 *
 * The whole suite runs with a fixed 320×640 viewport (set once via test.use;
 * mid-test resizes flake on webkit's dvh handling).
 */
test.use({ viewport: { width: 320, height: 640 } });

let course: Course;
let student: TestingUser;
let assignment: Assignment;
let submissionId: number;
let threadId: number;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E A11y Reflow Class" });
  [student] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Reflow Student", useMagicLink: true }
  ]);

  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Reflow Assignment",
    assignment_slug: `e2e-reflow-${course.id}`
  });
  const sub = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  submissionId = sub.submission_id;

  // A discussion thread so the two-pane discussion shell renders.
  const { data: topicRow } = await supabase
    .from("discussion_topics")
    .select("id")
    .eq("class_id", course.id)
    .order("ordinal", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: thread, error: threadErr } = await supabase
    .from("discussion_threads")
    .insert({
      subject: "Reflow thread subject",
      body: "A body long enough to actually wrap at three hundred and twenty pixels of viewport width.",
      topic_id: topicRow!.id,
      is_question: false,
      instructors_only: false,
      author: student.private_profile_id,
      class_id: course.id,
      draft: false,
      root_class_id: course.id
    })
    .select("id")
    .single();
  expect(threadErr).toBeNull();
  threadId = thread!.id;

  await insertOfficeHoursQueue({ class_id: course.id, name: "Reflow Queue" });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student]);
});

test.describe("reflow at 320px (400% zoom equivalent)", () => {
  test("course dashboard reflows", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}`);
    await assertReflowAt320(page, "course dashboard");
  });

  test("assignments list reflows", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);
    await expect(page.getByRole("heading", { name: /assignments/i }).first()).toBeVisible();
    await assertReflowAt320(page, "assignments list");
  });

  test("submission results page reflows", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}/results`);
    await expect(page.getByRole("heading", { name: "Test Results" })).toBeVisible({ timeout: 30_000 });
    await assertReflowAt320(page, "submission results");
  });

  test("gradebook reflows", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/gradebook`);
    await assertReflowAt320(page, "gradebook");
  });

  test("discussion list and thread reflow without clipped panes", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/discussion`);
    await assertReflowAt320(page, "discussion list");

    await page.goto(`/course/${course.id}/discussion/${threadId}`);
    await expect(page.getByText("Reflow thread subject").first()).toBeVisible({ timeout: 30_000 });
    await assertReflowAt320(page, "discussion thread");
  });

  test("office hours reflows without clipped panes", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/office-hours`);
    await assertReflowAt320(page, "office hours");
  });

  test("surveys list reflows", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/surveys`);
    await assertReflowAt320(page, "surveys list");
  });
});
