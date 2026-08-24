import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertHelpQueueAssignment,
  insertHelpRequest,
  insertOfficeHoursQueue,
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
    // recovering from transient GoTrue contention, which alone can exceed the
    // default 60s budget and time the test out mid-login. Allow extra headroom so
    // a slow-but-successful login doesn't surface as a flake.
    test.slow();
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
    await page.getByRole("button", { name: "Submit Request" }).click();

    // newRequestForm.tsx awaits helpRequests.create() then router.push() to
    // /office-hours/{queue_id}/{request_id}. The router.push must land — if
    // it doesn't, the user is stuck on the form (production bug).
    await page.waitForURL(/\/office-hours\/\d+\/\d+$/);
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

    await page.waitForURL(/\/office-hours\/\d+\/\d+$/);
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

// Regressions from the 2026-08 office-hours audit.
//
// 1. Saving the "Referenced Code" panel used to recompute
//    `is_private = (has file refs OR has submission ref)` and write it back, so a save
//    that left no references published a request the student had chosen to keep private.
//    That exposed the whole thread, not just the row: RLS on help_request_messages goes
//    through can_access_help_request(), which branches on this flag.
// 2. The "Follow-Up to Previous Request" field was collected by the form (and pre-filled
//    from ?followup_to=, which the queue list's Follow-Up button links to) and then
//    dropped: create_help_request_with_participants had no p_followup_to parameter and
//    its INSERT never listed the column, so followup_to was always null.
const PRIVACY_REGRESSION_REQUEST = "Private request with code references - must stay private 🔒";
const FOLLOWUP_ORIGINAL_REQUEST = "Original request to be followed up on";
const FOLLOWUP_NEW_REQUEST = "Follow-up: still stuck after our last session";

test.describe("Office Hours audit regressions", () => {
  test.describe.configure({ mode: "serial" });

  // A dedicated staffed queue. The suite above leaves the student holding an open public
  // AND an open private request in the class's default "office-hours" queue, and
  // create_help_request_with_participants allows only one open solo request per
  // (queue, creator, privacy) — so creating here from a clean queue keeps these tests
  // independent of what ran before them.
  let queueId: number;
  test.beforeAll(async () => {
    const queue = await insertOfficeHoursQueue({ class_id: course.id, name: "Audit Regression Queue" });
    queueId = queue.id;
    await insertHelpQueueAssignment({
      class_id: course.id,
      help_queue_id: queueId,
      ta_profile_id: instructor!.private_profile_id
    });
  });

  test("Dropping the last code reference does not publish a private help request", async ({ page }) => {
    // Three magic-link verifications (two API clients plus the browser login) on top of a
    // full page load; the default budget is tight under CI parallelism.
    test.slow();

    const { id: requestId } = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student!.private_profile_id,
      request: PRIVACY_REGRESSION_REQUEST,
      help_queue_id: queueId
    });
    // insertHelpRequest seeds public requests; this one is the student's private one.
    const { error: privacyError } = await supabase
      .from("help_requests")
      .update({ is_private: true })
      .eq("id", requestId);
    expect(privacyError).toBeNull();

    // Attach a code reference: the state whose removal used to trigger the flip.
    const { data: submissionFile, error: fileError } = await supabase
      .from("submission_files")
      .select("id")
      .eq("submission_id", submission_id!)
      .limit(1)
      .single();
    expect(fileError).toBeNull();
    const { error: refError } = await supabase.from("help_request_file_references").insert({
      class_id: course.id,
      help_request_id: requestId,
      assignment_id: assignment!.id,
      submission_id: submission_id!,
      submission_file_id: submissionFile!.id,
      line_number: 1
    });
    expect(refError).toBeNull();

    // Baseline: the other student cannot see the private request at all.
    const student2Client = await createAuthenticatedClient(student2!);
    const { data: visibleBefore } = await student2Client.from("help_requests").select("id").eq("id", requestId);
    expect(visibleBefore ?? []).toHaveLength(0);

    // Part 1 — the removal write itself, issued with the owner's own credentials. This is
    // byte-for-byte the update the client sent when the last code reference was removed.
    // It is asserted here rather than through the editing UI because that UI only renders
    // the per-file remove button while a submission is still selected, so reaching a
    // zero-reference save through it needs a chakra-react-select clear interaction, which
    // is flaky across browser projects (see instructor-group-management.spec.ts).
    const studentClient = await createAuthenticatedClient(student!);
    const { error: deleteRefError } = await studentClient
      .from("help_request_file_references")
      .delete()
      .eq("help_request_id", requestId);
    expect(deleteRefError).toBeNull();

    const { error: downgradeError } = await studentClient
      .from("help_requests")
      .update({ referenced_submission_id: null, is_private: false })
      .eq("id", requestId);
    // forbid_help_request_privacy_downgrade: only staff may publish a private request.
    expect(downgradeError).not.toBeNull();
    expect(downgradeError?.code).toBe("42501");

    // Part 2 — the path a student can actually reach in the UI. With no references left,
    // the panel offers "Add code references"; entering and saving it used to write
    // is_private=false as a side effect of an edit that changed nothing else.
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/office-hours/${queueId}/${requestId}`);

    // The code-reference panel sits inside the collapsed "N students" details accordion, so
    // the Add button is not in the DOM until that is expanded.
    const addButton = page.getByRole("button", { name: "Add code references" });
    await expect(async () => {
      if (!(await addButton.isVisible())) {
        await page.getByRole("button", { name: /^\d+ students?$/ }).click();
      }
      await expect(addButton).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });

    // handleEditClick bails until the (now empty) file-reference list has loaded, so the
    // first click can be a no-op. Retry until the editor is actually open.
    await expect(async () => {
      await addButton.click();
      await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    // Assert on the save request itself rather than on a success toast. On this path the
    // toast is a false negative: with no submission referenced, the post-save
    // refetchSubmission() issues submissions?id=eq.null, which 400s
    // ("invalid input syntax for type bigint") and sends handleSaveChanges into its catch,
    // so the user sees "Failed to update code references" even though every write landed.
    // That is a pre-existing defect on the refetch path, unrelated to privacy, and it
    // predates this change -- the old is_private-clearing code hit it too. Waiting on the
    // PATCH keeps this test non-vacuous: it proves the save really was issued and accepted,
    // which is what makes the is_private assertions below meaningful.
    const savePatch = page.waitForResponse(
      (r) => r.url().includes("/rest/v1/help_requests") && r.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "Save Changes" }).click();
    const saveResponse = await savePatch;
    expect(saveResponse.status()).toBeLessThan(300);

    // The request is still private...
    const { data: afterRow, error: afterError } = await supabase
      .from("help_requests")
      .select("is_private")
      .eq("id", requestId)
      .single();
    expect(afterError).toBeNull();
    expect(afterRow?.is_private).toBe(true);

    // ...and the other student still cannot see it, which is the disclosure that the
    // flip caused: help_request_messages RLS reads the same flag.
    const { data: visibleAfter } = await student2Client.from("help_requests").select("id").eq("id", requestId);
    expect(visibleAfter ?? []).toHaveLength(0);
  });

  test("A follow-up request records the request it follows up on", async ({ page }) => {
    test.slow();

    // Only resolved/closed requests are offered as follow-up targets.
    const { id: originalId } = await insertHelpRequest({
      class_id: course.id,
      student_profile_id: student!.private_profile_id,
      request: FOLLOWUP_ORIGINAL_REQUEST,
      help_queue_id: queueId,
      status: "resolved"
    });
    const { error: resolveError } = await supabase
      .from("help_requests")
      .update({ resolved_at: new Date().toISOString(), resolved_by: instructor!.private_profile_id })
      .eq("id", originalId);
    expect(resolveError).toBeNull();

    await loginAsUser(page, student!, course);
    // The queue list's Follow-Up button links to exactly this URL.
    await page.goto(`/course/${course.id}/office-hours/${queueId}/new?followup_to=${originalId}`);
    await expect(page.getByRole("form", { name: "New Help Request Form" })).toBeVisible();
    // The pre-fill has to land, or the round-trip assertion below would pass vacuously
    // for the wrong reason (nothing selected, nothing to drop).
    await expect(page.getByText(FOLLOWUP_ORIGINAL_REQUEST).first()).toBeVisible();

    await page.getByRole("textbox", { name: "Help Request Description" }).fill(FOLLOWUP_NEW_REQUEST);
    await page.getByRole("button", { name: "Submit Request" }).click();
    await page.waitForURL(/\/office-hours\/\d+\/\d+$/);

    const createdId = Number(page.url().split("/").pop());
    expect(Number.isFinite(createdId)).toBe(true);
    const { data: created, error: createdError } = await supabase
      .from("help_requests")
      .select("id, request, followup_to")
      .eq("id", createdId)
      .single();
    expect(createdError).toBeNull();
    expect(created?.request).toBe(FOLLOWUP_NEW_REQUEST);
    // The whole point: the form's follow-up selection reaches the column.
    expect(created?.followup_to).toBe(originalId);
  });
});
