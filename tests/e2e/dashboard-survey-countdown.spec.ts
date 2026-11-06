import type { Page, Request, Route } from "@playwright/test";
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

// The refresh is a server action, a POST to the current page with a next-action header. An RSC GET
// counts too, because router.refresh() sends one, and it must show up here if it ever comes back.
// Link prefetches use the same header, so they are told apart by next-router-prefetch and the path.
function isDashboardRefresh(request: Request, courseId: number) {
  if (new URL(request.url()).pathname !== `/course/${courseId}`) return false;
  const headers = request.headers();
  return request.method() === "POST"
    ? Boolean(headers["next-action"])
    : headers["rsc"] === "1" && !headers["next-router-prefetch"];
}

function recordDashboardRefreshes(page: Page, courseId: number) {
  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (isDashboardRefresh(request, courseId)) refreshes.push(request.url());
  });
  return refreshes;
}

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
      json: { pages: [{ elements: [{ type: "text", name: "q1", title: "How is it going?" }] }] },
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
    await loginAsUser(page, student, course);
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
    await loginAsUser(page, student, course);
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
    // It opens while the student is away, so only the refresh can bring its card.
    await seedPublishedSurvey("Opened While Away", dueAt + 5 * 60_000);
    await setTabVisibility(page, "visible");
    await expect(surveys.getByText("Due in 15 minutes", { exact: true })).toBeVisible();
    await expect(surveys.getByText("Opened While Away")).toBeVisible();
    expect(refreshes).toHaveLength(1);

    // Shown again inside the minute: this one must not refresh.
    await setTabVisibility(page, "hidden");
    await setTabVisibility(page, "visible");

    // A minute later it refreshes again, and brings the next survey that opened.
    await seedPublishedSurvey("Opened A Minute Later", dueAt + 10 * 60_000);
    await setTabVisibility(page, "hidden");
    await page.clock.setSystemTime(dueAt - 15 * 60_000 + 61_000);
    await setTabVisibility(page, "visible");
    await expect(surveys.getByText("Opened A Minute Later")).toBeVisible();
    // With that card on screen, an extra refresh inside the minute would have been counted by now.
    // The unit test pins the throttle exactly.
    expect(refreshes).toHaveLength(2);
  });

  // The network fails with the browser still reporting it's online, as on Wi-Fi that has only just
  // woken. The server fails with the network fine. router.refresh() fails differently in each, and
  // the page has to come through both with the router still working.
  for (const [name, failRefresh] of [
    ["the network", (route: Route) => route.abort("namenotresolved")],
    [
      "the server",
      (route: Route) =>
        isDashboardRefresh(route.request(), course.id)
          ? route.fulfill({ status: 500, body: "Internal Server Error" })
          : route.fallback()
    ]
  ] as const) {
    test(`a refresh that fails because of ${name} keeps the dashboard, and the next show and a link still work`, async ({
      page
    }) => {
      await loginAsUser(page, student, course);
      const dueAt = Date.now() + 30 * 60_000;
      await seedPublishedSurvey("Submitted While Away", dueAt);

      await page.clock.install();
      const refreshes = recordDashboardRefreshes(page, course.id);
      await page.goto(`/course/${course.id}`);
      const surveys = surveysToComplete(page);
      await expect(surveys.getByText("Submitted While Away")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => {
        (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
      });
      await page.clock.setSystemTime(dueAt - 15 * 60_000);

      // Answered, not just sent, so the route can't be removed before this refresh has failed.
      let refreshAnswered = () => {};
      const answered = new Promise<void>((resolve) => (refreshAnswered = resolve));
      const failThenSignal = async (route: Route) => {
        const isRefresh = isDashboardRefresh(route.request(), course.id);
        await failRefresh(route);
        if (isRefresh) refreshAnswered();
      };
      await page.route("**/*", failThenSignal);
      await setTabVisibility(page, "hidden");
      await setTabVisibility(page, "visible");
      await answered;
      await expect(surveys.getByText("Submitted While Away")).toBeVisible();
      await page.unroute("**/*", failThenSignal);

      // The failure gave the minute back, so this show refreshes with no change to the clock. It
      // brings a survey that opened and takes away one that was submitted.
      await seedPublishedSurvey("Opened After The Failure", dueAt + 5 * 60_000);
      const { data: submitted, error: findError } = await supabase
        .from("surveys")
        .select("id")
        .eq("class_id", course.id)
        .eq("title", "Submitted While Away")
        .single();
      if (findError) throw new Error(`Failed to find survey: ${findError.message}`);
      const { error: submitError } = await supabase.from("survey_responses").insert({
        survey_id: submitted.id,
        profile_id: student.private_profile_id,
        response: {},
        is_submitted: true,
        submitted_at: new Date().toISOString()
      });
      if (submitError) throw new Error(`Failed to submit survey: ${submitError.message}`);
      // Retried because the page handles the failure a moment after the route answers it. A retry
      // inside the minute sends nothing once a refresh has gone out, and the count below checks that.
      await expect(async () => {
        await setTabVisibility(page, "hidden");
        await setTabVisibility(page, "visible");
        await expect(surveys.getByText("Opened After The Failure")).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 20_000 });
      await expect(surveys.getByText("Submitted While Away")).toHaveCount(0);
      expect(refreshes).toHaveLength(2);

      // The router still works: a link renders the survey page, in the same document. This survey
      // opened after the page loaded, so the course controller has to find it by ID.
      await page.clock.resume();
      await surveys.getByRole("link", { name: /Opened After The Failure/ }).click();
      await expect(page.getByRole("heading", { name: "Opened After The Failure", level: 1 })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    });
  }

  test("a dashboard opened with the browser clock past the deadline shows Overdue at once", async ({ page }) => {
    await loginAsUser(page, student, course);
    const dueAt = Date.now() + 5 * 60_000;
    await seedPublishedSurvey("Clock Ahead Survey", dueAt);

    // The server renders "Due in 5 minutes"; the browser's clock is already past the deadline,
    // as it is for a dashboard restored from the router cache. useNow reads the browser clock on
    // mount, so the card is Overdue before the first 30 s tick.
    // From a blank page, so the dashboard load below is the first page to see the moved clock.
    await page.goto("about:blank");
    await page.clock.install({ time: dueAt + 5 * 60_000 });
    await page.goto(`/course/${course.id}`);
    const surveys = surveysToComplete(page);
    await expect(surveys.getByText("Clock Ahead Survey")).toBeVisible();
    await expect(surveys.getByText("Overdue", { exact: true })).toBeVisible();
    await expect(surveys.getByText(/^Was due \d+ minutes ago$/)).toBeVisible();
  });
});
