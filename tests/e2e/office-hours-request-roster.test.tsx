import { Course } from "@/utils/supabase/DatabaseTypes";
import type { Page, Request, Response } from "@playwright/test";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createClass,
  createUserInClass,
  createUsersInClass,
  insertHelpQueueAssignment,
  insertHelpRequest,
  insertOfficeHoursQueue,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
dotenv.config({ path: ".env.local", quiet: true });

// #1003 and #1080. create_help_request_with_participants inserts the help_request_students rows,
// and their broadcast goes to help_request:<id>. Nobody has joined that channel yet, so
// safe_broadcast drops it. A student who stays on the page then has no roster row for their own
// request: no Resolve button (#1003), and after the TA resolves it, a spinner that never stops
// (#1080). A reload hides both, so the student and the TA each use their own browser and never
// reload.

let course: Course;
let student: TestingUser | undefined;
let otherStudent: TestingUser | undefined;
let ta: TestingUser | undefined;
let queueId: number;

const HISTORICAL_CHAT_TEXT = "This is a historical chat view. New messages cannot be sent.";

// Fill in the new request form, submit it, and wait for the request page to open. Returns the
// new request's id.
async function submitNewRequest(page: Page, description: string, { isPrivate = false } = {}): Promise<number> {
  await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
  await page.getByRole("textbox", { name: "Help Request Description" }).fill(description);
  if (isPrivate) {
    await page.locator("label").filter({ hasText: "Private" }).locator("svg").click();
  }
  await page.getByRole("button", { name: "Submit Request" }).click();
  await page.waitForURL(/\/office-hours\/\d+\/\d+$/);
  return Number(new URL(page.url()).pathname.split("/").pop());
}

// Matches the query the helpRequestStudents cache sends when the new request form page first loads.
//
// Two other help_request_students queries also go out after the student submits the form: the
// lookup of the new request's rows (help_request_id=eq.) and the refetch of those rows by id
// (id=in.). This matches neither of them.
//
// The course page that loginAsUser opens also sends a roster query. The browser cancels it when
// the test goes to the form, so this skips it by checking that the query came from the form page.
function isFormRosterFirstLoad(request: Request): boolean {
  const url = request.url();
  return (
    request.method() === "GET" &&
    url.includes("/rest/v1/help_request_students?") &&
    url.includes("class_id=eq.") &&
    request.frame().url().endsWith("/new")
  );
}

// Matches the response to the form's refetch of the new request's rows by id.
function isRefetchById(response: Response): boolean {
  return /\/rest\/v1\/help_request_students\?.*[?&]id=in\./.test(response.url());
}

test.beforeAll(async () => {
  course = await createClass({ name: "OH Request Roster" });
  [student, otherStudent, ta] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Roster Student", useMagicLink: true },
    { role: "student", class_id: course.id, name: "Roster Other Student", useMagicLink: true },
    { role: "grader", class_id: course.id, name: "Roster TA", useMagicLink: true }
  ]);
  const { data: queue, error } = await supabase
    .from("help_queues")
    .select("id")
    .eq("class_id", course.id)
    .eq("name", "office-hours")
    .single();
  if (error || !queue) {
    throw new Error(`Failed to find office hours queue: ${error?.message ?? "not found"}`);
  }
  queueId = queue.id;
  // The New Request button stays disabled until someone is on duty.
  await insertHelpQueueAssignment({
    class_id: course.id,
    help_queue_id: queueId,
    ta_profile_id: ta!.private_profile_id
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, otherStudent, ta]);
  // A student can have at most one open public request and one open private request in a queue.
  // Close every request this test left open, so that the next test can submit the form.
  await supabase
    .from("help_requests")
    .update({ status: "closed" })
    .eq("class_id", course.id)
    .in("status", ["open", "in_progress"]);
});

test.describe("Office hours request roster", () => {
  test("A new request's page keeps the student's roster through the TA's resolve, without a reload", async ({
    page,
    browser
  }) => {
    // Two magic-link logins and a full help session.
    test.slow();
    await loginAsUser(page, student!, course);

    // Reach the form from the queue page, as a student normally would. The office hours caches load
    // before the request exists, and no page load refreshes them after it is created.
    await page.goto(`/course/${course.id}/office-hours/${queueId}`);
    await page.getByRole("link", { name: "New Request" }).click();
    const requestId = await submitNewRequest(page, "Roster check: my tests hang");
    await expect(page.getByText("Your position in the queue")).toBeVisible();

    const taContext = await browser.newContext();
    try {
      const taPage = await taContext.newPage();
      await loginAsUser(taPage, ta!, course);
      await taPage.goto(`/course/${course.id}/manage/office-hours/request/${requestId}`);
      await taPage.getByRole("button", { name: "Start Helping" }).click();
      await expect(taPage.getByRole("button", { name: "Stop Helping" })).toBeVisible();

      // #1003: the student is on the roster and can resolve. Soft, so a failure here still lets
      // the run reach the #1080 check below.
      await expect.soft(page.getByText("1 student", { exact: true })).toBeVisible();
      await expect.soft(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();

      // In WebKit and Safari, the first click on the Resolve button scrolls the page instead of
      // opening the confirm popover. Focus lands on <main tabIndex={-1}> and the page scrolls main to
      // the top of the window, so the click ends on another element. Click again until the confirm
      // button shows.
      const confirmResolve = taPage.getByRole("button", { name: "Confirm action" });
      await expect(async () => {
        if (!(await confirmResolve.isVisible())) {
          await taPage.getByRole("button", { name: "Resolve", exact: true }).click();
        }
        await expect(confirmResolve).toBeVisible({ timeout: 2_000 });
      }).toPass();
      await confirmResolve.click();
      await expect
        .poll(async () => {
          const { data } = await supabase.from("help_requests").select("status").eq("id", requestId).single();
          return data?.status;
        })
        .toBe("resolved");

      // #1080: the student's page shows the resolved request instead of a spinner.
      await expect(page.getByText(HISTORICAL_CHAT_TEXT)).toBeVisible();
      await expect(page.getByRole("button", { name: "Feedback" })).toBeVisible();
    } finally {
      await taContext.close();
    }
  });

  test("A student who is not on a resolved public request can open it", async ({ page }) => {
    // The page used to look up the request only in this user's requests and the queue's open
    // requests, so a resolved request from someone else matched neither and the page spun forever.
    const { id: requestId } = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student!.private_profile_id,
      request: "Roster check: already resolved",
      help_queue_id: queueId,
      status: "resolved"
    });
    await loginAsUser(page, otherStudent!, course);
    await page.goto(`/course/${course.id}/office-hours/${queueId}/${requestId}`);
    await expect(page.getByText(HISTORICAL_CHAT_TEXT)).toBeVisible();
  });

  test("A new request keeps its roster when the first roster response arrives after the request is created", async ({
    page
  }) => {
    // When the helpRequestStudents cache finishes its first load, it replaces all of its rows with
    // the result. That load starts when the form page opens, before the request exists, so its
    // result has no rows for the new request. If the result arrives after the form has already
    // added the new request's rows, it overwrites them. The page then goes from "1 student" and a
    // Resolve button to "0 students" and no Resolve button.
    test.slow();
    await loginAsUser(page, student!, course);

    // Hold back the response to the form page's first roster query. The query itself runs now,
    // before the request exists, so the response has no rows for the new request.
    let releaseFirstLoad!: () => void;
    const firstLoadReleased = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    let markFirstLoadDelivered!: () => void;
    const firstLoadDelivered = new Promise<void>((resolve) => {
      markFirstLoadDelivered = resolve;
    });
    let heldFirstLoad = false;
    let firstLoadWasDelivered = false;
    await page.route("**/rest/v1/help_request_students?*", async (route) => {
      if (!heldFirstLoad && isFormRosterFirstLoad(route.request())) {
        heldFirstLoad = true;
        const response = await route.fetch();
        await firstLoadReleased;
        await route.fulfill({ response });
        firstLoadWasDelivered = true;
        markFirstLoadDelivered();
        return;
      }
      await route.continue();
    });
    // Count the refetch responses, and the ones that arrive after the held response.
    let refetches = 0;
    let refetchesAfterFirstLoad = 0;
    page.on("response", (response) => {
      if (isRefetchById(response)) {
        refetches++;
        if (firstLoadWasDelivered) {
          refetchesAfterFirstLoad++;
        }
      }
    });
    const rosterLookup = page.waitForResponse(
      (response) =>
        response.url().includes("/rest/v1/help_request_students?") && response.url().includes("help_request_id=eq.")
    );

    await page.goto(`/course/${course.id}/office-hours/${queueId}/new`);
    await submitNewRequest(page, "Roster check: slow first load");
    await rosterLookup;
    expect(heldFirstLoad).toBe(true);
    // The form refetches the rows right away, so the page can show them while the first load is
    // held.
    await expect.poll(() => refetches).toBeGreaterThan(0);
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();

    // The form's second refetch has to wait for the first load. If it doesn't, it comes back now.
    // Wait up to 3 seconds for it, so that the held response is the one that arrives last. With
    // the fix, the form hasn't sent the second refetch yet, and this wait times out.
    await expect
      .poll(() => refetches, { timeout: 3_000 })
      .toBeGreaterThan(1)
      .catch(() => {});

    // With the fix, the form sends its second refetch only after the cache has processed the
    // held response. So when that refetch comes back, the overwrite is already over, and the
    // student's row should be back. Without the fix, both refetches came back before the held
    // response, no refetch comes after it, and the test fails here.
    releaseFirstLoad();
    await firstLoadDelivered;
    await expect.poll(() => refetchesAfterFirstLoad, { timeout: 10_000 }).toBeGreaterThan(0);

    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  });

  test("A new request gets its roster when the first roster query fails", async ({ page }) => {
    // The form waits for the helpRequestStudents cache's first load to finish, even if it fails.
    // Check that a failed first load doesn't count as a failure to load the new request's rows: the
    // roster shows, and the student gets no error toast.
    test.slow();
    await loginAsUser(page, student!, course);

    let releaseFirstLoad!: () => void;
    const firstLoadReleased = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    let failedFirstLoad = false;
    await page.route("**/rest/v1/help_request_students?*", async (route) => {
      if (!failedFirstLoad && isFormRosterFirstLoad(route.request())) {
        failedFirstLoad = true;
        await firstLoadReleased;
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"test failure"}' });
        return;
      }
      await route.continue();
    });
    let refetches = 0;
    page.on("response", (response) => {
      if (isRefetchById(response)) {
        refetches++;
      }
    });
    const rosterLookup = page.waitForResponse(
      (response) =>
        response.url().includes("/rest/v1/help_request_students?") && response.url().includes("help_request_id=eq.")
    );

    await page.goto(`/course/${course.id}/office-hours/${queueId}/new`);
    await submitNewRequest(page, "Roster check: failed first load");
    await rosterLookup;
    expect(failedFirstLoad).toBe(true);
    releaseFirstLoad();

    // The form refetches once right away and once after the first load has settled. The second
    // refetch only happens if the form carried on past the failed first load.
    await expect.poll(() => refetches, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    await expect(page.getByText("Could not load the students on this request")).toHaveCount(0);
  });

  test("A new request shows its roster while the first roster query is still running", async ({ page }) => {
    // The helpRequestStudents cache's first load has no timeout. If it never answers, the form must
    // not wait for it before showing the new request's rows.
    test.slow();
    await loginAsUser(page, student!, course);

    let heldFirstLoad = false;
    await page.route("**/rest/v1/help_request_students?*", async (route) => {
      if (!heldFirstLoad && isFormRosterFirstLoad(route.request())) {
        heldFirstLoad = true;
        // Never answer it.
        return;
      }
      await route.continue();
    });

    await page.goto(`/course/${course.id}/office-hours/${queueId}/new`);
    await submitNewRequest(page, "Roster check: first load never answers");
    expect(heldFirstLoad).toBe(true);

    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  });

  test("A new request whose roster rows fail to load shows a reload toast", async ({ page }) => {
    // refetchByIds sends a failed query to Sentry and returns normally. The form checks the
    // cache afterwards, so the student still learns that the roster didn't load.
    test.slow();
    await loginAsUser(page, student!, course);

    await page.route("**/rest/v1/help_request_students?*", async (route) => {
      if (/[?&]id=in\./.test(route.request().url())) {
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"test failure"}' });
        return;
      }
      await route.continue();
    });

    await page.goto(`/course/${course.id}/office-hours/${queueId}/new`);
    await submitNewRequest(page, "Roster check: refetch fails");

    // Toasts are display:none in e2e runs, so check that the toast is in the page, not that it
    // is visible.
    await expect(page.getByText("Could not load the students on this request")).toBeAttached();
    await expect(page.getByText("0 students", { exact: true })).toBeVisible();
  });

  test("A new private request shows the student's roster and stays hidden from other students", async ({
    page,
    browser
  }) => {
    test.slow();
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/office-hours/${queueId}/new`);
    const requestId = await submitNewRequest(page, "Roster check: private request", { isPrivate: true });

    await expect(page.getByText("1 student", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();

    // Check that a student who is not on the private request can't open it. RLS keeps the row
    // from ever reaching this student, so this checks the page as a whole for a privacy leak. It
    // does not test the cached-row fallback on its own.
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await loginAsUser(otherPage, otherStudent!, course);
      await otherPage.goto(`/course/${course.id}/office-hours/${queueId}/${requestId}`);
      // RLS hides the private request from this student. The page's fetch for it returns an
      // error, so the page shows "Unable to load this request" instead of "Request not found."
      await expect(otherPage.getByText(/^(Request not found\.|Unable to load this request)/)).toBeVisible();
      await expect(otherPage.getByText("Roster check: private request")).toHaveCount(0);
    } finally {
      await otherContext.close();
    }
  });

  test("A request from another course is not found on this course's page", async ({ page }) => {
    // The student is enrolled in both courses, so they can read this request. Without the course
    // check, the page would show it under the wrong course.
    const otherCourse = await createClass({ name: "OH Request Roster Other Course" });
    const studentInOtherCourse = await createUserInClass({
      role: "student",
      class_id: otherCourse.id,
      email: student!.email,
      useMagicLink: true
    });
    const { id: requestId } = await insertHelpRequest({
      class_id: otherCourse.id,
      student_profile_id: studentInOtherCourse.private_profile_id,
      request: "Roster check: other course",
      status: "resolved"
    });
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/office-hours/${queueId}/${requestId}`);
    await expect(page.getByText("Request not found.")).toBeVisible();
    await expect(page.getByText(HISTORICAL_CHAT_TEXT)).toHaveCount(0);
  });

  test("A request opened under another queue of its course moves to its own queue", async ({ page }) => {
    const otherQueue = await insertOfficeHoursQueue({ class_id: course.id, name: "roster-other-queue" });
    const { id: requestId } = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student!.private_profile_id,
      request: "Roster check: other queue",
      help_queue_id: queueId,
      status: "resolved"
    });
    await loginAsUser(page, otherStudent!, course);
    await page.goto(`/course/${course.id}/office-hours/${otherQueue.id}/${requestId}`);
    await page.waitForURL(new RegExp(`/office-hours/${queueId}/${requestId}$`));
    await expect(page.getByText(HISTORICAL_CHAT_TEXT)).toBeVisible();
  });
});
