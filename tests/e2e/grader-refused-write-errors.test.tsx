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
// RLS on `assignments` only lets instructors UPDATE. When a grader saved Edit Assignment, PostgREST
// matched 0 rows and answered `200 []`, `@refinedev/supabase` turned that into `{ data: undefined }`
// with no error, and the page showed the green "Assignment Updated" toast for a save that never
// happened. `lib/refineDataProvider.ts` now throws a 403 when an update returns no row, so the
// page's existing catch shows "Update Error" instead.
//
// The unit tests in tests/unit/refine-data-provider.test.ts cover the provider logic with stubbed
// responses; this test is the end-to-end proof against real RLS as a seeded grader.
//
// Save is clicked WITHOUT editing any field. The edit page renders the form twice (responsive
// variants in ManageAssignmentNav.tsx) and react-hook-form binds to the last-mounted one, so typed
// edits are unreliable under Playwright (see assignment-repo-config-form.test.tsx). An unchanged
// save still issues the UPDATE, which is all RLS needs to refuse.

const RUN_PREFIX = getTestRunPrefix();
const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let course: Course;
let grader: TestingUser | undefined;
let assignment: Assignment;

const futureDue = addDays(new TZDate(new Date(), "America/New_York"), 14);
futureDue.setHours(9, 0, 0, 0);

test.describe("Grader writes refused by RLS surface an error", () => {
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
      due_date: futureDue.toUTCString()
    });
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([grader]);
  });

  test("a grader saving Edit Assignment sees an error, not 'Assignment Updated'", async ({ page }) => {
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
