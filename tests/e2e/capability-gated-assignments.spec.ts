/**
 * #1010 step 4b: creating and editing an assignment need manage_assignments. Without it, New
 * Assignment, the Edit Assignment nav item and the groups page's (Edit) link are hidden, and the
 * /new and /edit pages send you back to the assignment list. Instructors see no change.
 *
 * Default roles only: the instructor role holds manage_assignments, the grader role doesn't.
 */
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  insertAssignment,
  loginAsUser,
  type TestingUser
} from "./TestingUtils";

test.describe.configure({ mode: "serial" });

test.describe("assignment create and edit gated by manage_assignments", () => {
  test.describe.configure({ timeout: 180_000 });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let assignmentId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Assignment Gates ${suffix}` });
    instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E Assignment Gates ${suffix}`,
      assignment_slug: `e2e-asg-${suffix}`,
      group_config: "both",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: addDays(new Date(), 14).toISOString()
    });
    assignmentId = assignment.id;
  });

  const listUrl = () => `/course/${course.id}/manage/assignments`;
  const assignmentUrl = () => `${listUrl()}/${assignmentId}`;

  // useCapability is false while loading, so "hidden" only means something once the answer is in.
  async function gotoWithCapabilities(page: Page, url: string, waitFor: (page: Page) => Promise<void>) {
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await page.goto(url);
    await waitFor(page);
    await capabilities;
  }

  const listLoaded = (page: Page) =>
    expect(page.getByRole("link", { name: "All regrade requests" })).toBeVisible({ timeout: 60_000 });
  const groupsLoaded = (page: Page) =>
    expect(page.getByRole("heading", { name: "Configure Groups" })).toBeVisible({ timeout: 60_000 });

  test("a grader doesn't see New Assignment, Edit Assignment or the groups (Edit) link", async ({ page }) => {
    await loginAsUser(page, grader, course);
    await gotoWithCapabilities(page, listUrl(), listLoaded);
    await expect(page.getByRole("link", { name: "New Assignment" })).toHaveCount(0);

    await gotoWithCapabilities(page, `${assignmentUrl()}/groups`, groupsLoaded);
    await expect(page.getByRole("link", { name: "Manage Groups" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit Assignment" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  });

  test("a grader who opens /new or /edit is sent back to the assignment list", async ({ page }) => {
    await loginAsUser(page, grader, course);
    for (const url of [`${listUrl()}/new`, `${assignmentUrl()}/edit`]) {
      await page.goto(url);
      await expect(page, url).toHaveURL(new RegExp(`${listUrl()}$`));
      await listLoaded(page);
    }
  });

  test("an instructor still sees and opens New Assignment and Edit Assignment", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await gotoWithCapabilities(page, listUrl(), listLoaded);
    await expect(page.getByRole("link", { name: "New Assignment" })).toBeVisible();

    await gotoWithCapabilities(page, `${assignmentUrl()}/groups`, groupsLoaded);
    await expect(page.getByRole("link", { name: "Edit Assignment" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();

    await gotoCourseUrlWhenHeadingVisible(page, `${listUrl()}/new`, "Create New Assignment");
    await gotoCourseUrlWhenHeadingVisible(page, `${assignmentUrl()}/edit`, "Edit Assignment");
  });
});
