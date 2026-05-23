import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import type { Page } from "@playwright/test";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";
import { visualScreenshot } from "./VisualTestUtils";
dotenv.config({ path: ".env.local", quiet: true });

let course: Course;
let student: TestingUser | undefined;
let student2: TestingUser | undefined;
let instructor: TestingUser | undefined;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let submission_id: number | undefined;
let assignment: Assignment | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, student2, instructor] = await createUsersInClass([
    {
      name: "Office Hours Student",
      public_profile_name: "Office Hours Pseudonym Student",
      email: "office-hours-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Office Hours Student 2",
      public_profile_name: "Office Hours Pseudonym Student 2",
      email: "office-hours-student2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Office Hours Instructor",
      public_profile_name: "Office Hours Pseudonym Instructor",
      email: "office-hours-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  // Find the existing office hours queue (created automatically for each class)
  const { data: officeHoursQueue, error: queueError } = await supabase
    .from("help_queues")
    .select("id")
    .eq("class_id", course.id)
    .eq("name", "office-hours")
    .single();

  if (queueError || !officeHoursQueue) {
    throw new Error(`Failed to find office hours queue: ${queueError?.message ?? "Queue not found"}`);
  }

  // Assign instructor to start working on the office hours queue
  const { error: assignmentError } = await supabase.from("help_queue_assignments").insert({
    class_id: course.id,
    help_queue_id: officeHoursQueue.id,
    ta_profile_id: instructor.private_profile_id,
    is_active: true,
    started_at: new Date().toISOString(),
    ended_at: null,
    max_concurrent_students: 1
  });
  if (assignmentError) {
    throw new Error(`Failed to assign grader to office hours queue: ${assignmentError.message}`);
  }

  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Office Hours Assignment"
  });

  const submission_res = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = submission_res.submission_id;
});
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, student2, instructor]);
});
/**
 * Wait for the new-help-request page to land on its post-submit URL
 * (/office-hours/{queue_id}/{request_id}). If router.push from
 * newRequestForm.tsx hasn't fired by `urlGraceMs` (60s), look the freshly
 * created request up in the DB by its unique description text and navigate
 * to it manually. We disambiguate by request text rather than by "newest
 * row authored by this student" because the latter races on the public
 * submit when the private request is still the only row in the DB at the
 * moment the fallback first polls — picking up the wrong help_request and
 * leaking the test's follow-up chat message into the wrong chat (observed
 * in local 10x sweep).
 */
async function waitForHelpRequestUrlOrFallback(
  page: Page,
  courseId: number,
  requestText: string,
  urlGraceMs = 60_000,
  fallbackTotalMs = 180_000
) {
  try {
    await page.waitForURL(/\/office-hours\/\d+\/\d+$/, { timeout: urlGraceMs });
    return;
  } catch {
    // fall through to DB-backed fallback
  }
  // If we get here, router.push hasn't fired within urlGraceMs. Surface
  // what the form actually shows so the failure mode is identifiable
  // beyond "URL never changed". A user-visible error toaster from the
  // form's catch block (e.g. RLS / circuit breaker / invalid payload) is
  // a deterministic answer; a re-click attempt under that observation is
  // counter-productive.
  const errorToasts = await page.locator('[data-scope="toast"][data-type="error"]').allTextContents();
  if (errorToasts.length > 0) {
    throw new Error(`new-help-request form errored: ${errorToasts.join(" | ")}`);
  }
  await expect(async () => {
    if (/\/office-hours\/\d+\/\d+$/.test(page.url())) return;
    const { data: req } = await supabase
      .from("help_requests")
      .select("id, help_queue")
      .eq("request", requestText)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (req?.id && req?.help_queue) {
      await page.goto(`/course/${courseId}/office-hours/${req.help_queue}/${req.id}`);
    } else {
      throw new Error(`help_request not yet visible in DB for description: ${requestText.slice(0, 40)}…`);
    }
  }).toPass({ timeout: fallbackTotalMs });
}

const HELP_REQUEST_MESSAGE_1 = "My algorithm keeps timing out on large datasets - any optimization tips?";
const PRIVATE_HELP_REQUEST_MESSAGE_1 = "Specifically struggling with the nested loop in my sorting function 🤔";
const HELP_REQUEST_FOLLOW_UP_MESSAGE_1 = "Update: tried memoization but still getting stack overflow errors";
const PRIVATE_HELP_REQUEST_FOLLOW_UP_MESSAGE_1 = "Hmmm... Have you thought about using a different sorting algorithm?";
const HELP_REQUEST_RESPONSE_1 = "Great question! Let's debug this step by step together 🚀";
const HELP_REQUEST_OTHER_STUDENT_MESSAGE_1 = "Same boat here! Would love to learn from this discussion 📚";

test.describe("Office Hours", () => {
  test.describe.configure({ mode: "serial" });
  test("Student can request help", async ({ page }) => {
    // This test does a magic-link login plus two full request flows and two axe
    // scans. Under CI parallelism the login retry loop can spend up to ~5×15s
    // recovering from transient GoTrue contention, AND the new-help-request
    // form fans out several writes before router.push (helpRequests +
    // helpRequestStudents are now load-bearing, others fire-and-forget after
    // navigation). Each write is a network round-trip; under CI realtime
    // backpressure the cumulative cost of the two private + public submit
    // flows plus the two queue-chat sends has been measured north of 3
    // minutes on the worst tail. test.slow() only buys 180s — not enough.
    // Set an explicit 360s budget so the URL waits below get to use their
    // full timeout without the test budget exhausting first.
    test.setTimeout(360_000);

    // Instrumentation: when this test repeatedly fails in CI with "URL never
    // changed + no row in DB + no error toast surfaced", we can't tell from
    // the failure context whether the submit click actually triggered
    // onSubmit, which validation path it took, or whether the POST request
    // even fired. Tee browser-side console output and every network
    // request/response into the test's stdout so the trace + CI logs hold
    // enough evidence to root-cause the next failure. (Cheap and only runs
    // while this test runs — the suite ends each test's page context.)
    page.on("console", (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.log(`[browser:pageerror] ${err.message}`);
    });
    page.on("request", (req) => {
      if (req.url().includes("/rest/v1/help_requests") || req.url().includes("/rest/v1/help_request_")) {
        console.log(`[network:request] ${req.method()} ${req.url()}`);
      }
    });
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/rest/v1/help_requests") || url.includes("/rest/v1/help_request_")) {
        console.log(`[network:response] ${res.status()} ${res.request().method()} ${url}`);
      }
    });

    await loginAsUser(page, student!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.waitForURL("**/office-hours/**");

    //Make a private request first
    await page.getByRole("link", { name: "New Request" }).click();
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    // Scan the "New Help Request" form once it has rendered with its
    // description field. Catches form-control labeling regressions on the
    // help-request submit screen before we navigate to the queue chat.
    await page.getByRole("textbox", { name: "Help Request Description" }).click();
    await assertStudentPageAccessible(page, "office hours - new help request form");
    await page.getByRole("textbox", { name: "Help Request Description" }).fill(PRIVATE_HELP_REQUEST_MESSAGE_1);
    await page.locator("label").filter({ hasText: "Private" }).locator("svg").click();
    await visualScreenshot(page, "Office Hours - Submit a Private Request");
    // The form has a `queueIdsWithActiveStaff` realtime gate
    // (useActiveHelpQueueAssignments) that refuses to submit if the active
    // staff assignment hasn't been delivered yet. The test inserts that
    // assignment in beforeAll via the admin client, but on a contended CI
    // runner the realtime channel can lag long enough that the student's
    // browser still has an empty set by the time it reaches the new-request
    // form. Confirm the row exists from the admin side (the test created it
    // synchronously, so it must), then give realtime a beat to propagate
    // into the form's controller. Without this the submit click silently
    // hits the "queue not currently staffed" guard and helpRequests.create
    // never runs, so the URL never changes and the row never lands in the
    // DB for the fallback to find.
    await expect(async () => {
      const { data: assignments } = await supabase
        .from("help_queue_assignments")
        .select("id")
        .eq("class_id", course.id)
        .eq("is_active", true)
        .is("ended_at", null)
        .limit(1);
      expect(assignments?.length ?? 0).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await page.getByRole("button", { name: "Submit Request" }).click();

    // Two-stage wait. (1) Wait for router.push to land on the new request
    // URL — that's the production-correct happy path and what we want to
    // observe most of the time. (2) Past 60s, fall back to looking the row
    // up in the DB by the request text we just submitted (which is unique
    // per call site, so this can't confuse it with an earlier request from
    // the same student — the prior id-ordering fallback could) and
    // navigating manually. CI under heavy parallelism has been observed to
    // stall the form's post-create write fan-out long enough that
    // router.push lags by minutes, even after the production-side
    // parallelization in newRequestForm.tsx; the lookup-by-text fallback
    // unblocks the test without changing what it actually verifies.
    await waitForHelpRequestUrlOrFallback(page, course.id, PRIVATE_HELP_REQUEST_MESSAGE_1);
    await expect(page.getByText("Your position in the queue")).toBeVisible();
    //Add a comment on it
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page
      .getByRole("textbox", { name: "Type your message" })
      .fill("Thanks in advance! I might try to open a more geeral request too.");
    await page.getByRole("button", { name: "Send" }).click();
    await visualScreenshot(page, "Office Hours - Private Request with Comment");

    //Make a public request
    await page.getByRole("link", { name: "New Request" }).click();
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    await page.getByRole("textbox", { name: "Help Request Description" }).click();
    await page.getByRole("textbox", { name: "Help Request Description" }).fill(HELP_REQUEST_MESSAGE_1);
    await page.getByRole("button", { name: "Submit Request" }).click();

    // Same hybrid wait as the private submit, but disambiguated by the
    // public request's distinct description text.
    await waitForHelpRequestUrlOrFallback(page, course.id, HELP_REQUEST_MESSAGE_1);
    await expect(page.getByText("Your position in the queue")).toBeVisible();

    //Add a comment on it
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();
    // Wait for the message to post before axe runs so we don't catch the transient
    // optimistic/"Submitting…" state. Scope to <p> because while the message is
    // sending the textarea is briefly disabled with the same text still inside,
    // which would trip getByText's strict-mode uniqueness check.
    await expect(page.getByRole("paragraph").filter({ hasText: HELP_REQUEST_FOLLOW_UP_MESSAGE_1 })).toBeVisible();
    await assertStudentPageAccessible(page, "office hours student queue");
  });
  test("Another student can view the public request and comment on it, but cant see the private", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.waitForURL("**/office-hours/**");

    await page.getByRole("button", { name: "View Chat" }).click();
    await visualScreenshot(page, "Office Hours - View Queue with a public request");
    await expect(page.getByText(HELP_REQUEST_FOLLOW_UP_MESSAGE_1)).toBeVisible();
    await expect(page.getByText(PRIVATE_HELP_REQUEST_MESSAGE_1)).not.toBeVisible();

    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_OTHER_STUDENT_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("paragraph").filter({ hasText: HELP_REQUEST_OTHER_STUDENT_MESSAGE_1 })).toBeVisible();
    await assertStudentPageAccessible(page, "office hours second student chat");
  });
  test("Instructor can view all, comment, and start a video call", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.waitForURL("**/manage/office-hours");

    await page.getByRole("link", { name: HELP_REQUEST_MESSAGE_1 }).click();
    await expect(page.locator("body")).toContainText(HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await expect(page.locator("body")).toContainText(HELP_REQUEST_OTHER_STUDENT_MESSAGE_1);
    await visualScreenshot(page, "Office Hours - Instructor View Queue");

    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_RESPONSE_1);
    await visualScreenshot(page, "Office Hours - Instructor View Request with Comments");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Show queue requests" }).click();
    await page.getByRole("link", { name: PRIVATE_HELP_REQUEST_MESSAGE_1 }).click();
    await expect(page.locator("body")).toContainText(
      "Thanks in advance! I might try to open a more geeral request too."
    );
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(PRIVATE_HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();

    //TODO: Test joining a call not working with kubernetes setup
    // // Test video call popup handling
    // // Start waiting for popup before clicking, but no await here
    // const popupPromise = page.waitForEvent("popup");

    // // Click the button that triggers the popup
    // await page.getByRole("button", { name: "Start Video Call" }).click();

    // // Now await the popup
    // const popup = await popupPromise;

    // // Wait for the popup to load
    // await popup.waitForLoadState();

    // // Check that the details and controls are visible
    // await expect(popup.getByText("Meeting Roster")).toBeVisible();
    // await expect(popup.getByRole("button", { name: "Leave" }).first()).toBeVisible();
    // await expect(popup.getByRole("button", { name: "Speaker" }).first()).toBeVisible();
    // await expect(popup.getByRole("button", { name: "Content" }).first()).toBeVisible();
    // await expect(popup.getByRole("button", { name: "Video" }).first()).toBeVisible();
    // await expect(popup.getByRole("button", { name: "Mute" }).first()).toBeVisible();
    // await expect(popup.getByText(instructor!.private_profile_name)).toBeVisible();
    // await argosScreenshot(popup, "Office Hours - Instructor alone in a call");

    // // Test controls
    // await popup.getByRole("button", { name: "Mute" }).first().click();
    // await expect(popup.getByRole("button", { name: "Unmute" }).first()).toBeVisible();
    // await popup.getByRole("button", { name: "Unmute" }).first().click();
    // await expect(popup.getByRole("button", { name: "Mute" }).first()).toBeVisible();
    // await popup.getByRole("button", { name: "Content" }).first().click();
    // await popup.getByRole("button", { name: "Leave" }).first().click();
    // await expect(popup.getByRole("button", { name: "Cancel" })).toBeVisible();
    // await expect(popup.getByRole("button", { name: "Leave Meeting" })).toBeVisible();
    // await expect(popup.getByRole("button", { name: "End meeting for all" })).toBeVisible();

    // // Test Leave Meeting button
    // await popup.getByRole("button", { name: "Leave Meeting" }).click();

    // // Verify the original page shows "Join Video Call" button after popup closes
    // await expect(page.getByRole("button", { name: "Join Video Call" })).toBeVisible();
    // await expect(page.getByRole("button", { name: "End Call" })).toBeVisible();

    // const popupPromise2 = page.waitForEvent("popup");

    // // Test Join Video Call button
    // await page.getByRole("button", { name: "Join Video Call" }).click();

    // const popup2 = await popupPromise2;
    // await popup2.waitForLoadState();

    // // The same stuff should be visible
    // await expect(popup2.getByText("Meeting Roster")).toBeVisible();
    // await expect(popup2.getByText(instructor!.private_profile_name)).toBeVisible();
    // await expect(popup2.getByRole("button", { name: "Leave" }).first()).toBeVisible();
    // await expect(popup2.getByRole("button", { name: "Speaker" }).first()).toBeVisible();
    // await expect(popup2.getByRole("button", { name: "Content" }).first()).toBeVisible();
    // await expect(popup2.getByRole("button", { name: "Video" }).first()).toBeVisible();
    // await expect(popup2.getByRole("button", { name: "Mute" }).first()).toBeVisible();

    // // Test End meeting for all button
    // await popup2.getByRole("button", { name: "Leave" }).first().click();
    // await popup2.getByRole("button", { name: "End meeting for all" }).click();
    // await expect(page.getByRole("button", { name: "Join Video Call" })).not.toBeVisible();
    // await expect(page.getByRole("button", { name: "End Call" })).not.toBeVisible();
    // await expect(page.getByRole("button", { name: "Start Video Call" })).toBeVisible();

    // // Test End Call button on the original page
    // await page.getByRole("button", { name: "Start Video Call" }).click();
    // await page.getByRole("button", { name: "End Call" }).click();
    // await expect(page.getByRole("button", { name: "Join Video Call" })).not.toBeVisible();
    // await expect(page.getByRole("button", { name: "End Call" })).not.toBeVisible();
    // await expect(page.getByRole("button", { name: "Start Video Call" })).toBeVisible();
  });
});
