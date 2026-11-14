import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import {
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

// Regression coverage for #1125 / #983 (PR 1 of the error-surfacing stack).
//
// When RLS refuses an UPDATE, PostgREST matches 0 rows and answers `200 []`. `@refinedev/supabase`
// turned that into `{ data: undefined }` with no error, so Edit Assignment showed the green
// "Assignment Updated" toast for a save that never happened. `lib/refineDataProvider.ts` now throws
// a 403 when an update returns no row, so the page's existing catch shows "Update Error" instead.
//
// Since #1199, edit/layout.tsx sends anyone without manage_assignments back to the assignment list,
// so a default grader can no longer reach Save. The page can still be out of date, though: here a
// grader on a custom role that holds manage_assignments opens Edit Assignment, and the capability is
// then taken off that role (an instructor editing the role, in real life) before Save is clicked.
// The page still renders the form, but RLS on `assignments` now refuses the UPDATE. Before the
// provider fix that showed "Assignment Updated".
//
// The unit tests in tests/unit/refine-data-provider.test.ts cover the provider logic with stubbed
// responses; this test is the end-to-end proof against real RLS.
//
// Save is clicked WITHOUT editing any field. The edit page renders the form twice (responsive
// variants in ManageAssignmentNav.tsx) and react-hook-form binds to the last-mounted one, so typed
// edits are unreliable under Playwright (see assignment-repo-config-form.test.tsx). An unchanged
// save still issues the UPDATE, which is all RLS needs to refuse.
//
// The assignment is created with repo_mode "none", so it has no handout repo. With a handout, a
// save that the provider wrongly treats as successful goes on to call githubRepoConfigureWebhook,
// and that call's failure also shows "Update Error". The Update Error check then passed even with
// the fix reverted. With no handout, the unfixed page reaches "Assignment Updated", which is the
// bug in #983.

const RUN_PREFIX = getTestRunPrefix();
const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let course: Course;
let grader: TestingUser | undefined;
let assignment: Assignment;
let editorRoleId: number;

const futureDue = addDays(new TZDate(new Date(), "America/New_York"), 14);
futureDue.setHours(9, 0, 0, 0);

test.describe("Writes refused by RLS surface an error", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    course = await createClass({ name: `Refused Writes ${RUN_PREFIX}` });
    grader = await createUserInClass({
      role: "grader",
      class_id: course.id,
      email: `refused-writes-grader-${SAFE_ID}@pawtograder.net`,
      name: `Refused Writes Grader ${RUN_PREFIX}`,
      useMagicLink: true
    });
    assignment = await insertAssignment({
      class_id: course.id,
      name: `Refused Writes Target ${RUN_PREFIX}`,
      assignment_slug: `rw-${SAFE_ID.slice(-8)}`,
      due_date: futureDue.toUTCString(),
      repo_mode: "none"
    });

    // A custom role holding manage_assignments, with the grader on it, so edit/layout.tsx lets them in.
    const { data: role, error: roleError } = await supabase
      .from("class_roles")
      .insert({ class_id: course.id, name: `Assignment Editor ${SAFE_ID}` })
      .select("id")
      .single();
    expect(roleError).toBeNull();
    editorRoleId = role!.id;

    const { error: capabilityError } = await supabase
      .from("role_capabilities")
      .insert({ role_id: editorRoleId, capability: "manage_assignments" });
    expect(capabilityError).toBeNull();

    const { error: assignError } = await supabase
      .from("user_roles")
      .update({ class_role_id: editorRoleId })
      .eq("user_id", grader!.user_id)
      .eq("class_id", course.id);
    expect(assignError).toBeNull();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([grader]);
  });

  test("saving Edit Assignment after losing manage_assignments shows an error, not 'Assignment Updated'", async ({
    page
  }) => {
    const { data: before, error: beforeError } = await supabase
      .from("assignments")
      .select("title, updated_at")
      .eq("id", assignment.id)
      .single();
    expect(beforeError).toBeNull();

    await loginAsUser(page, grader!, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit Assignment" }).first()).toBeVisible();
    // Wait for the loaded row to reach the form, so Save sends a real UPDATE for this id.
    await expect(page.getByLabel("Title", { exact: false }).first()).toHaveValue(assignment.title);

    // The page is open; now take manage_assignments away, as an instructor editing the role would.
    const { error: revokeError } = await supabase
      .from("role_capabilities")
      .delete()
      .eq("role_id", editorRoleId)
      .eq("capability", "manage_assignments");
    expect(revokeError).toBeNull();

    // The visual-test fixture hides the toaster (display:none); turn it off so the toast is visible.
    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));
    await page
      .locator("button:visible", { hasText: /^Save$/ })
      .first()
      .click();

    // The refusal is reported, with the provider's message naming what was refused.
    await expect(page.getByText("Update Error").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/don't have permission to update this assignments record/).first()).toBeVisible();
    // ...and the false success the bug produced is gone.
    await expect(page.getByText("Assignment Updated")).toHaveCount(0);

    // The database agrees nothing changed.
    const { data: after } = await supabase
      .from("assignments")
      .select("title, updated_at")
      .eq("id", assignment.id)
      .single();
    expect(after).toEqual(before);
  });
});
