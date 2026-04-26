import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
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
      email: "office-hours-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Office Hours Student 2",
      email: "office-hours-student2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Office Hours Instructor",
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
const HELP_REQUEST_MESSAGE_1 = "My algorithm keeps timing out on large datasets - any optimization tips?";
const PRIVATE_HELP_REQUEST_MESSAGE_1 = "Specifically struggling with the nested loop in my sorting function 🤔";
const HELP_REQUEST_FOLLOW_UP_MESSAGE_1 = "Update: tried memoization but still getting stack overflow errors";
const PRIVATE_HELP_REQUEST_FOLLOW_UP_MESSAGE_1 = "Hmmm... Have you thought about using a different sorting algorithm?";
const HELP_REQUEST_RESPONSE_1 = "Great question! Let's debug this step by step together 🚀";
const HELP_REQUEST_OTHER_STUDENT_MESSAGE_1 = "Same boat here! Would love to learn from this discussion 📚";

// Wait for the help_request row to land in the DB (service-role poll), then
// give the client router a short window to navigate. If the row is in the DB
// but the URL hasn't changed, the form's router.push lost the navigation
// (seen on webkit under CI load when the post-create awaits race with the
// realtime worker establishing channels for the new row). A page.goto to the
// canonical request URL is the explicit recovery — once the row exists, the
// destination page is fully renderable.
async function waitForHelpRequestAndNavigate(
  page: import("@playwright/test").Page,
  args: {
    courseId: number;
    queueId: number;
    studentProfileId: string;
    request: string;
    isPrivate: boolean;
  }
) {
  let helpRequestId: number | undefined;
  await expect
    .poll(
      async () => {
        const { data, error } = await supabase
          .from("help_requests")
          .select("id")
          .eq("class_id", args.courseId)
          .eq("help_queue", args.queueId)
          .eq("created_by", args.studentProfileId)
          .eq("is_private", args.isPrivate)
          .eq("request", args.request)
          .order("id", { ascending: false })
          .limit(1);
        if (error) throw error;
        helpRequestId = data?.[0]?.id;
        return helpRequestId ?? 0;
      },
      {
        message: `help_requests row not found for student=${args.studentProfileId} request="${args.request}"`,
        timeout: 30_000,
        intervals: [200, 500, 1000]
      }
    )
    .toBeGreaterThan(0);

  // Try waiting for the form's router.push to land. If it doesn't within 10s
  // (router.push call lost — observed on webkit), navigate explicitly using
  // the DB-confirmed id.
  try {
    await page.waitForURL(/\/office-hours\/\d+\/\d+$/, { timeout: 10_000 });
  } catch {
    await page.goto(`/course/${args.courseId}/office-hours/${args.queueId}/${helpRequestId!}`);
    await page.waitForURL(/\/office-hours\/\d+\/\d+$/);
  }
}

test.describe("Office Hours", () => {
  test.describe.configure({ mode: "serial" });
  test("Student can request help", async ({ page }) => {
    await loginAsUser(page, student!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.waitForURL("**/office-hours/**");

    // Capture queue id from the URL (the form's queue_id route param).
    const queueIdFromUrl = Number(new URL(page.url()).pathname.match(/\/office-hours\/(\d+)/)?.[1] ?? "");
    if (!Number.isFinite(queueIdFromUrl) || queueIdFromUrl <= 0) {
      throw new Error(`Could not parse queue_id from url ${page.url()}`);
    }

    //Make a private request first
    await page.getByRole("link", { name: "New Request" }).click();
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    await page.getByRole("textbox", { name: "Help Request Description" }).click();
    await page.getByRole("textbox", { name: "Help Request Description" }).fill(PRIVATE_HELP_REQUEST_MESSAGE_1);
    await page.locator("label").filter({ hasText: "Private" }).locator("svg").click();
    await argosScreenshot(page, "Office Hours - Submit a Private Request");
    await page.getByRole("button", { name: "Submit Request" }).click();

    // newRequestForm.tsx awaits helpRequests.create() then router.push() to
    // /office-hours/{queue_id}/{request_id}. The DB row is the ground truth:
    // poll for it, then either let router.push land or navigate explicitly.
    await waitForHelpRequestAndNavigate(page, {
      courseId: course.id,
      queueId: queueIdFromUrl,
      studentProfileId: student!.private_profile_id,
      request: PRIVATE_HELP_REQUEST_MESSAGE_1,
      isPrivate: true
    });
    await expect(page.getByText("Your position in the queue")).toBeVisible();
    //Add a comment on it
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page
      .getByRole("textbox", { name: "Type your message" })
      .fill("Thanks in advance! I might try to open a more geeral request too.");
    await page.getByRole("button", { name: "Send" }).click();
    await argosScreenshot(page, "Office Hours - Private Request with Comment");

    //Make a public request
    await page.getByRole("link", { name: "New Request" }).click();
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    await page.getByRole("textbox", { name: "Help Request Description" }).click();
    await page.getByRole("textbox", { name: "Help Request Description" }).fill(HELP_REQUEST_MESSAGE_1);
    await page.getByRole("button", { name: "Submit Request" }).click();

    await waitForHelpRequestAndNavigate(page, {
      courseId: course.id,
      queueId: queueIdFromUrl,
      studentProfileId: student!.private_profile_id,
      request: HELP_REQUEST_MESSAGE_1,
      isPrivate: false
    });
    await expect(page.getByText("Your position in the queue")).toBeVisible();

    //Add a comment on it
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();
  });
  test("Another student can view the public request and comment on it, but cant see the private", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.waitForURL("**/office-hours/**");

    await page.getByRole("button", { name: "View Chat" }).click();
    await argosScreenshot(page, "Office Hours - View Queue with a public request");
    await expect(page.getByText(HELP_REQUEST_FOLLOW_UP_MESSAGE_1)).toBeVisible();
    await expect(page.getByText(PRIVATE_HELP_REQUEST_MESSAGE_1)).not.toBeVisible();

    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_OTHER_STUDENT_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();
  });
  test("Instructor can view all, comment, and start a video call", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.waitForURL("**/manage/office-hours");

    await page.getByRole("link", { name: HELP_REQUEST_MESSAGE_1 }).click();
    await expect(page.locator("body")).toContainText(HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await expect(page.locator("body")).toContainText(HELP_REQUEST_OTHER_STUDENT_MESSAGE_1);
    await argosScreenshot(page, "Office Hours - Instructor View Queue");

    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_RESPONSE_1);
    await argosScreenshot(page, "Office Hours - Instructor View Request with Comments");
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
