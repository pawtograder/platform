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
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    await page.getByRole("textbox", { name: "Help Request Description" }).fill("Roster check: my tests hang");
    await page.getByRole("button", { name: "Submit Request" }).click();
    await page.waitForURL(/\/office-hours\/\d+\/\d+$/);
    const requestId = Number(new URL(page.url()).pathname.split("/").pop());
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
});
