import type { Page } from "@playwright/test";
import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

// The "Surveys to complete" block on the student dashboard: the label and the cards under it.
function surveysToComplete(page: Page) {
  return page.getByText("Surveys to complete", { exact: true }).locator("..");
}

// There is no browser API to hide a tab from a test, so this stands in for switching tabs:
// it overrides what the page reads and fires the event the browser would fire.
async function setTabVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

// router.refresh() refetches the current page as an RSC payload. Link prefetches use the same
// header, so they are told apart by next-router-prefetch and by the path.
function recordDashboardRefreshes(page: Page, courseId: number) {
  const refreshes: string[] = [];
  page.on("request", (request) => {
    const headers = request.headers();
    if (headers["rsc"] !== "1" || headers["next-router-prefetch"]) return;
    if (new URL(request.url()).pathname !== `/course/${courseId}`) return;
    refreshes.push(request.url());
  });
  return refreshes;
}

const HYDRATION_ERROR = /hydrat|did(?: not|n't) match|Minified React error #4(?:18|23|25)/i;

test.describe("Student dashboard survey countdown", () => {
  let course: Course;
  let student: User;
  let instructor: User;

  async function seedPublishedSurvey(title: string, dueAt: number) {
    const { error } = await supabase.from("surveys").insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assigned_to_all: true,
      allow_response_editing: false,
      json: {},
      version: 1,
      status: "published",
      title,
      due_date: new Date(dueAt).toISOString()
    });
    if (error) {
      throw new Error(`Failed to seed survey: ${error.message}`);
    }
  }

  test.beforeAll(async () => {
    course = await createClass({ name: "Survey Countdown Course" });
    [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Countdown Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Countdown Instructor", useMagicLink: true }
    ]);
  });

  test.beforeEach(async () => {
    // One survey per test, so each card's text belongs to the survey the test seeded.
    const { error } = await supabase.from("surveys").delete().eq("class_id", course.id);
    if (error) {
      throw new Error(`Failed to clear surveys: ${error.message}`);
    }
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student, instructor]);
  });

  test("a survey left open on the dashboard turns Overdue within 30 s of its deadline, without a reload", async ({
    page
  }) => {
    await loginAsUser(page, student);
    const dueAt = Date.now() + 3 * 60_000;
    await seedPublishedSurvey("Deadline Survey", dueAt);

    await page.clock.install();
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText("Deadline Survey")).toBeVisible();
    await expect(surveys.getByText("Pending", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Due in \d+ minutes?$/)).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
    });

    // Stop the clock just before the deadline; from here on time moves only when the test moves it.
    await page.clock.pauseAt(dueAt - 5_000);
    await expect(surveys.getByText("Pending", { exact: true })).toBeVisible();

    // 30 s past the deadline.
    await page.clock.runFor(35_000);
    await expect(surveys.getByText("Overdue", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Was due .+ ago$/)).toBeVisible();
    await expect(surveys.getByText("Pending", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  });

  test("a hidden dashboard shows the current countdown as soon as it is shown again, and refreshes at most once a minute", async ({
    page
  }) => {
    await loginAsUser(page, student);
    const dueAt = Date.now() + 30 * 60_000;
    await seedPublishedSurvey("Background Tab Survey", dueAt);

    await page.clock.install();
    const refreshes = recordDashboardRefreshes(page, course.id);
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText(/^Due in \d+ minutes$/)).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Paused, no timer fires, so only showing the tab can change what the card says.
    await page.clock.pauseAt(dueAt - 25 * 60_000);
    await setTabVisibility(page, "hidden");
    await page.clock.setSystemTime(dueAt - 15 * 60_000);
    await setTabVisibility(page, "visible");
    await expect(surveys.getByText("Due in 15 minutes", { exact: true })).toBeVisible();
    await expect.poll(() => refreshes.length).toBe(1);

    // Shown again within the same minute: no second refresh.
    await setTabVisibility(page, "hidden");
    await setTabVisibility(page, "visible");
    await page.waitForTimeout(2_000);
    expect(refreshes).toHaveLength(1);

    // A minute later it refreshes again.
    await setTabVisibility(page, "hidden");
    await page.clock.setSystemTime(dueAt - 15 * 60_000 + 61_000);
    await setTabVisibility(page, "visible");
    await expect.poll(() => refreshes.length).toBe(2);
    await page.waitForTimeout(1_000);
    expect(refreshes).toHaveLength(2);
  });

  test("the countdown hydrates from the server's time and then follows the browser clock", async ({ page }) => {
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && HYDRATION_ERROR.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      if (HYDRATION_ERROR.test(error.message)) {
        hydrationErrors.push(error.message);
      }
    });

    await loginAsUser(page, student);
    const dueAt = Date.now() + 5 * 60_000;
    await seedPublishedSurvey("Hydration Survey", dueAt);

    // The server renders "Due in 5 minutes"; the browser's clock is already past the deadline,
    // as it would be for a dashboard restored from the router cache. A first client render that
    // read the browser clock would not match the server HTML.
    await page.clock.install({ time: dueAt + 5 * 60_000 });
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText("Hydration Survey")).toBeVisible();
    await expect(surveys.getByText("Overdue", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Was due \d+ minutes ago$/)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(hydrationErrors).toEqual([]);
  });
});
