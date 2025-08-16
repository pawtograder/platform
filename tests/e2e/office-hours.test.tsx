import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { expect, test } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertOfficeHoursQueue,
  insertPreBakedSubmission,
  loginAsUser,
  TestingUser
} from "./TestingUtils";
dotenv.config({ path: ".env.local" });

let course: Course;
let student: TestingUser | undefined;
let student2: TestingUser | undefined;
let instructor: TestingUser | undefined;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let submission_id: number | undefined;
let assignment: Assignment | undefined;

test.beforeAll(async () => {
  course = await createClass();
  student = await createUserInClass({ role: "student", class_id: course.id });
  student2 = await createUserInClass({ role: "student", class_id: course.id });
  instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  await insertOfficeHoursQueue({ class_id: course.id, name: "office-hours" });
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id
  });

  const submission_res = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = submission_res.submission_id;
});

const HELP_REQUEST_MESSAGE_1 = "My algorithm keeps timing out on large datasets - any optimization tips?";
const PRIVATE_HELP_REQUEST_MESSAGE_1 = "Specifically struggling with the nested loop in my sorting function 🤔";
const HELP_REQUEST_FOLLOW_UP_MESSAGE_1 = "Update: tried memoization but still getting stack overflow errors";
const PRIVATE_HELP_REQUEST_FOLLOW_UP_MESSAGE_1 = "Hmmm... Have you thought about using a different sorting algorithm?";
const HELP_REQUEST_RESPONSE_1 = "Great question! Let's debug this step by step together 🚀";
const HELP_REQUEST_OTHER_STUDENT_MESSAGE_1 = "Same boat here! Would love to learn from this discussion 📚";

test.describe("Office Hours", () => {
  test.describe.configure({ mode: "serial" });
  test("Student can request help", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await page.getByRole("link").filter({ hasText: "Office Hours" }).click();

    //Make a private request first
    await page.getByRole("link", { name: "New Request" }).click();
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    await page.getByRole("textbox").click();
    await page.getByRole("textbox").fill(PRIVATE_HELP_REQUEST_MESSAGE_1);
    await page.locator("label").filter({ hasText: "Private" }).locator("svg").click();
    await argosScreenshot(page, "Office Hours - Submit a Private Request");
    await page.getByRole("button", { name: "Submit Request" }).click();

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
    await page.getByRole("textbox").click();
    await page.getByRole("textbox").fill(HELP_REQUEST_MESSAGE_1);
    await page.getByRole("button", { name: "Submit Request" }).click();

    await expect(page.getByText("Your position in the queue")).toBeVisible();

    //Add a comment on it
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();
  });
  test("Another student can view the public request and comment on it, but cant see the private", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    await page.getByRole("link").filter({ hasText: "Office Hours" }).click();
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
    await page.getByRole("link").filter({ hasText: "Office Hours" }).click();
    await page.getByRole("link", { name: HELP_REQUEST_MESSAGE_1 }).click();
    await expect(page.locator("body")).toContainText(HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await expect(page.locator("body")).toContainText(HELP_REQUEST_OTHER_STUDENT_MESSAGE_1);
    await argosScreenshot(page, "Office Hours - Instructor View Queue");

    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(HELP_REQUEST_RESPONSE_1);
    await argosScreenshot(page, "Office Hours - Instructor View Request with Comments");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("link", { name: PRIVATE_HELP_REQUEST_MESSAGE_1 }).click();
    await expect(page.locator("body")).toContainText(
      "Thanks in advance! I might try to open a more geeral request too."
    );
    await page.getByRole("textbox", { name: "Type your message" }).click();
    await page.getByRole("textbox", { name: "Type your message" }).fill(PRIVATE_HELP_REQUEST_FOLLOW_UP_MESSAGE_1);
    await page.getByRole("button", { name: "Send" }).click();

    // Test video call popup handling
    // Start waiting for popup before clicking, but no await here
    const popupPromise = page.waitForEvent("popup");

    // Click the button that triggers the popup
    await page.getByRole("button", { name: "Start Video Call" }).click();

    // Now await the popup
    const popup = await popupPromise;

    // Wait for the popup to load
    await popup.waitForLoadState();

    // Check that the details and controls are visible
    await expect(popup.getByText("Meeting Roster")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Leave" }).first()).toBeVisible();
    await expect(popup.getByRole("button", { name: "Speaker" }).first()).toBeVisible();
    await expect(popup.getByRole("button", { name: "Content" }).first()).toBeVisible();
    await expect(popup.getByRole("button", { name: "Video" }).first()).toBeVisible();
    await expect(popup.getByRole("button", { name: "Mute" }).first()).toBeVisible();
    await expect(popup.getByText(instructor!.private_profile_name)).toBeVisible();
    await argosScreenshot(popup, "Office Hours - Instructor alone in a call");

    // Test controls
    await popup.getByRole("button", { name: "Mute" }).first().click();
    await expect(popup.getByRole("button", { name: "Unmute" }).first()).toBeVisible();
    await popup.getByRole("button", { name: "Unmute" }).first().click();
    await expect(popup.getByRole("button", { name: "Mute" }).first()).toBeVisible();
    await popup.getByRole("button", { name: "Content" }).first().click();
    await popup.getByRole("button", { name: "Leave" }).first().click();
    await expect(popup.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Leave Meeting" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "End meeting for all" })).toBeVisible();

    // Test Leave Meeting button
    await popup.getByRole("button", { name: "Leave Meeting" }).click();

    // Verify the original page shows "Join Video Call" button after popup closes
    await expect(page.getByRole("button", { name: "Join Video Call" })).toBeVisible();
    await expect(page.getByRole("button", { name: "End Call" })).toBeVisible();

    const popupPromise2 = page.waitForEvent("popup");

    // Test Join Video Call button
    await page.getByRole("button", { name: "Join Video Call" }).click();

    const popup2 = await popupPromise2;
    await popup2.waitForLoadState();

    // The same stuff should be visible
    await expect(popup2.getByText("Meeting Roster")).toBeVisible();
    await expect(popup2.getByText(instructor!.private_profile_name)).toBeVisible();
    await expect(popup2.getByRole("button", { name: "Leave" }).first()).toBeVisible();
    await expect(popup2.getByRole("button", { name: "Speaker" }).first()).toBeVisible();
    await expect(popup2.getByRole("button", { name: "Content" }).first()).toBeVisible();
    await expect(popup2.getByRole("button", { name: "Video" }).first()).toBeVisible();
    await expect(popup2.getByRole("button", { name: "Mute" }).first()).toBeVisible();

    // Test End meeting for all button
    await popup2.getByRole("button", { name: "Leave" }).first().click();
    await popup2.getByRole("button", { name: "End meeting for all" }).click();
    await expect(page.getByRole("button", { name: "Join Video Call" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "End Call" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Start Video Call" })).toBeVisible();

    // Test End Call button on the original page
    await page.getByRole("button", { name: "Start Video Call" }).click();
    await page.getByRole("button", { name: "End Call" }).click();
    await expect(page.getByRole("button", { name: "Join Video Call" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "End Call" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Start Video Call" })).toBeVisible();
  });
});
