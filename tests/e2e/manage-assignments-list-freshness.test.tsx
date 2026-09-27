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
 * Selects by href rather than accessible name: the mobile and desktop navs are both in the DOM,
 * so a name-based selector is ambiguous. (The names themselves are asserted separately below.)
 */
function courseNavLink(page: Page, href: string) {
  return page.locator(`nav[aria-label="Course navigation"]:visible a[href="${href}"]`).first();
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
    // Derive the slug from SAFE_ID, not from RUN_PREFIX: the form only accepts
    // /^[a-z0-9_-]+$/, and `RUN_PREFIX.slice(-6)` reaches back into the `#<random>` segment
    // whenever the trailing TEST_WORKER_INDEX is short or empty, which would make Save silently
    // reject the form.
    const slug = `lf-${SAFE_ID.slice(-8)}`;

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
    await courseNavLink(page, `/course/${course.id}/manage/assignments`).click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/assignments$`));

    // The timeout here is load-bearing and must stay well under `staleTimes.dynamic` (30s):
    // wait longer than the stale window and the cache entry expires on its own, and this test
    // passes whether or not the bug is fixed.
    await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: 10_000 });
  });

  // Regression guard for the a11y bug found while writing the test above: the desktop nav wrapped
  // each link's label in `role="group"`, which does not support accessible-name-from-content, so
  // every link in the primary course navigation exposed an EMPTY name — screen readers announced
  // a bare "link" (WCAG 2.4.4 / 4.1.2). It was invisible to sighted users and to any selector
  // that matches on href, which is why it survived.
  test("course navigation links expose their label as an accessible name", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/assignments`);

    const nav = page.locator('nav[aria-label="Course navigation"]:visible').first();
    await expect(nav.getByRole("link", { name: "Manage Assignments", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Discussion", exact: true })).toBeVisible();
  });
});
