/**
 * #983 PR 3 / #996: when publish_assignment_group_changes refuses a grader, the grader sees why.
 *
 * #996: a grader clicked Publish Changes on Manage Groups and got "Error publishing changes —
 * Unknown error". The function's refusal arrived as a plain PostgREST error object, which failed
 * `instanceof Error`. #1247 sends it through the shared error mapper. This PR gives the refusal
 * the code our other refusals use (42501, insufficient_privilege) and makes the mapper keep a
 * function's own 42501 message.
 *
 * Who may publish doesn't change here: the function still allows instructors and admins only
 * (moving it to the publish_groups capability belongs to #1010). The UI test therefore takes
 * publish_groups away after the page loads, like tests/e2e/grader-refused-write-errors.test.tsx,
 * so it keeps testing a refusal after that move too.
 */
import type { Course } from "@/utils/supabase/DatabaseTypes";
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  gotoCourseUrlWhenHeadingVisible,
  insertAssignment,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";

const REFUSAL = "Only instructors can publish group changes";

test.describe("group publish refused for a grader", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let course: Course;
  let grader: TestingUser;
  let assignmentId: number;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    course = await createClass({ name: `E2E Group Publish Refusal ${suffix}` });
    grader = await createUserInClass({ role: "grader", class_id: course.id });
    await createUserInClass({ role: "student", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `E2E Group Publish Refusal ${suffix}`,
      assignment_slug: `e2e-gpr-${suffix}`,
      group_config: "both",
      min_group_size: 1,
      max_group_size: 4,
      group_formation_deadline: addDays(new Date(), 14).toISOString(),
      repo_mode: "none"
    });
    assignmentId = assignment.id;
  });

  test("the function refuses a grader with 42501 and says why", async () => {
    const client = await createAuthenticatedClient(grader);
    const { data, error } = await client.rpc("publish_assignment_group_changes", {
      p_class_id: course.id,
      p_assignment_id: assignmentId,
      p_groups_to_create: [{ name: "e2erefused", member_ids: [] }],
      p_moves_to_fulfill: []
    });
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: "42501", message: REFUSAL });

    const { data: groups } = await supabase.from("assignment_groups").select("id").eq("assignment_id", assignmentId);
    expect(groups).toEqual([]);
  });

  test("Publish Changes shows the refusal, not 'Unknown error'", async ({ page }) => {
    // A custom role with publish_groups, so the grader gets the editable Manage Groups page.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: `Group Publisher ${Date.now()}` })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    const { error: capabilityError } = await supabase
      .from("role_capabilities")
      .insert({ role_id: role!.id, capability: "publish_groups" });
    expect(capabilityError).toBeNull();
    const { error: assignError } = await supabase
      .from("user_roles")
      .update({ class_role_id: role!.id })
      .eq("user_id", grader.user_id)
      .eq("class_id", course.id);
    expect(assignError).toBeNull();

    await loginAsUser(page, grader, course);
    const capabilities = page.waitForResponse((r) => r.url().includes("/rpc/user_class_capabilities") && r.ok());
    await gotoCourseUrlWhenHeadingVisible(
      page,
      `/course/${course.id}/manage/assignments/${assignmentId}/groups`,
      "Configure Groups"
    );
    await capabilities;

    // Stage a new group.
    await page.getByRole("button", { name: "Create New Group" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[name="name"]').fill(`e2egrp${Date.now().toString(36)}`);
    await dialog.getByRole("button", { name: "Save" }).click();
    const publish = page.getByRole("button", { name: "Publish Changes" });
    await expect(publish).toBeEnabled();

    // The page is open; now take publish_groups away.
    const { error: revokeError } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", role!.id)
      .eq("capability", "publish_groups");
    expect(revokeError).toBeNull();

    // The visual-test fixture hides the toaster (display:none); turn it off so the toast is visible.
    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));
    await publish.click();

    await expect(page.getByText("Error publishing changes").first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(`${REFUSAL}. If you need access, ask an instructor for this course.`).first()
    ).toBeVisible();
    await expect(page.getByText("Unknown error")).toHaveCount(0);

    const { data: groups } = await supabase.from("assignment_groups").select("id").eq("assignment_id", assignmentId);
    expect(groups).toEqual([]);
  });
});
