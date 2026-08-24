import { Course } from "@/utils/supabase/DatabaseTypes";
import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import { expect, test } from "../global-setup";
import type { Page } from "@playwright/test";
import { createClass, createUserInClass, getTestRunPrefix, loginAsUser, TestingUser } from "./TestingUtils";

// Regression coverage for issue #937: after creating an assignment, navigating back to Manage
// Assignments showed the pre-create list until a hard reload.
//
// The staleness lives in the browser, not the database. `ManageAssignmentsTable` is a Server
// Component that queries per request, so the server was never wrong. What was wrong is the
// client Router Cache: `next.config.ts` sets `experimental.staleTimes.dynamic: 30`, so the RSC
// payload rendered for a segment is replayed for 30s on client-side navigation back to it. The
// create flow's `revalidateCourseDerivedCachesClient()` call could not help — `revalidateTag()`
// evicts server data, not the payload the browser already holds. Only `router.refresh()` does.
//
// Which is why every step below has to be a *click*, not a `page.goto()`: a `goto` is a document
// request that bypasses the Router Cache entirely and would pass even with the bug present.

const RUN_PREFIX = getTestRunPrefix();
const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let course: Course;
let instructor: TestingUser | undefined;

const futureRelease = addDays(new TZDate(new Date(), "America/New_York"), 1);
futureRelease.setHours(9, 0, 0, 0);
const futureDue = addDays(new TZDate(new Date(), "America/New_York"), 14);
futureDue.setHours(9, 0, 0, 0);

function toDateTimeLocal(date: Date): string {
  return new TZDate(date, "America/New_York").toISOString().slice(0, -13);
}

/**
 * The mobile and desktop navs are both in the DOM, so match on the visible one.
 */
function visibleNavLink(page: Page, name: string) {
  return page.locator("nav:visible").getByRole("link", { name, exact: true }).first();
}

test.describe("Manage Assignments list freshness", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    course = await createClass({ name: `List Freshness ${RUN_PREFIX}` });
    instructor = await createUserInClass({
      role: "instructor",
      class_id: course.id,
      email: `list-freshness-instructor-${SAFE_ID}@pawtograder.net`,
      name: `List Freshness Instructor ${RUN_PREFIX}`,
      useMagicLink: true
    });
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([instructor]);
  });

  test("a newly created assignment is listed after navigating back, without a reload", async ({ page }) => {
    const title = `Freshness Target ${RUN_PREFIX}`;
    const slug = `lf-${RUN_PREFIX.slice(-6)}`;

    await loginAsUser(page, instructor!, course);

    // 1. Render the list. This is what seeds the Router Cache with a payload that does not
    //    contain the assignment we are about to create.
    await page.goto(`/course/${course.id}/manage/assignments`);
    await expect(page.getByRole("link", { name: "All regrade requests" })).toBeVisible();
    await expect(page.getByRole("link", { name: title })).toHaveCount(0);

    // 2. Client-side navigation away, so the list payload stays cached.
    await page.getByRole("link", { name: "New Assignment" }).click();
    await expect(page.getByRole("heading", { name: "Create New Assignment" })).toBeVisible();

    // 3. Create. repo_mode "none" keeps the flow off GitHub, so the redirect to the autograder
    //    tab is not gated on handout-repo creation.
    await page.getByLabel("Title", { exact: false }).fill(title);
    await page.getByLabel("Slug", { exact: false }).fill(slug);
    await page.getByLabel(/^Release date/i).fill(toDateTimeLocal(futureRelease));
    await page.getByLabel(/^Due date/i).fill(toDateTimeLocal(futureDue));
    await page.getByLabel("Points possible", { exact: false }).fill("100");
    await page.locator('select[name="repo_mode"]').selectOption("none");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page).toHaveURL(/\/manage\/assignments\/\d+\/autograder/, { timeout: 60_000 });

    // 4. Back to the list the way the bug report does it — the nav link, not a reload.
    await visibleNavLink(page, "Manage Assignments").click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/assignments$`));

    // The timeout here is load-bearing and must stay well under `staleTimes.dynamic` (30s):
    // wait longer than the stale window and the cache entry expires on its own, and this test
    // passes whether or not the bug is fixed.
    await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: 10_000 });
  });
});
