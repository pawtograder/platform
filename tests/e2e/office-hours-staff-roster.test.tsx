import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertHelpQueueAssignment,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
dotenv.config({ path: ".env.local", quiet: true });

// A request's roster rows (help_request_students) used to be broadcast only to help_request:<id>.
// A TA who is looking at the queue has not joined that channel, so when a student created a
// request, the TA's page never got its roster and showed "0 students" until a reload. The rows
// now also go to help_queues:<class_id>:staff, which every TA with office hours open has joined.
// The student and the TA each use their own browser, and the TA never reloads.

let course: Course;
let student: TestingUser | undefined;
let ta: TestingUser | undefined;
let queueId: number;

test.beforeAll(async () => {
  course = await createClass({ name: "OH Staff Roster" });
  [student, ta] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Staff Roster Student", useMagicLink: true },
    { role: "grader", class_id: course.id, name: "Staff Roster TA", useMagicLink: true }
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
  await logMagicLinksOnFailure([student, ta]);
  // A student can have at most one open public request in a queue. Close every request this test
  // left open, so that a retry can submit the form again.
  await supabase
    .from("help_requests")
    .update({ status: "closed" })
    .eq("class_id", course.id)
    .in("status", ["open", "in_progress"]);
});

test.describe("Office hours staff roster", () => {
  test("A TA who already has office hours open sees a new request's student without a reload", async ({
    page,
    browser
  }) => {
    // Two magic-link logins in two browsers.
    test.slow();
    const description = `Staff roster check ${Date.now()}`;

    const taContext = await browser.newContext();
    try {
      const taPage = await taContext.newPage();
      await loginAsUser(taPage, ta!, course);

      // Open the TA's queue before the request exists. Wait for the page's first roster load, so
      // that load can't be what brings in the new request's roster.
      const taFirstRosterLoad = taPage.waitForResponse(
        (response) =>
          response.url().includes("/rest/v1/help_request_students?") &&
          response.url().includes("class_id=eq.") &&
          response.request().frame().url().includes("/manage/office-hours")
      );
      await taPage.goto(`/course/${course.id}/manage/office-hours`);
      await taFirstRosterLoad;

      // safe_broadcast only sends to a channel that someone holds a lease on. Wait until the TA's
      // page holds one on the staff channel.
      await expect
        .poll(async () => {
          const { count } = await supabase
            .from("realtime_channel_subscriptions")
            .select("channel", { count: "exact", head: true })
            .eq("user_id", ta!.user_id)
            .eq("channel", `help_queues:${course.id}:staff`);
          return count;
        })
        .toBeGreaterThan(0);

      // The student creates a request from the form, as a student normally would.
      await loginAsUser(page, student!, course);
      await page.goto(`/course/${course.id}/office-hours/${queueId}`);
      await page.getByRole("link", { name: "New Request" }).click();
      await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
      await page.getByRole("textbox", { name: "Help Request Description" }).fill(description);
      await page.getByRole("button", { name: "Submit Request" }).click();
      await page.waitForURL(/\/office-hours\/\d+\/\d+$/);

      // The new help_requests row arrives on class:<class_id>:staff, so the request shows up in the
      // TA's queue. Opening it from the queue is a client-side navigation, so it doesn't reload the
      // roster either.
      await taPage.getByRole("link", { name: description }).click();
      await expect(taPage.getByText("1 student", { exact: true })).toBeVisible();
    } finally {
      await taContext.close();
    }
  });
});
