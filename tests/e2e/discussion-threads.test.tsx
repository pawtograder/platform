import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import { createClass, createUsersInClass, loginAsUser, TestingUser } from "./TestingUtils";
dotenv.config({ path: ".env.local" });

let course: Course;
let student1: TestingUser | undefined;
let student2: TestingUser | undefined;
let instructor: TestingUser | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student1, student2, instructor] = await createUsersInClass([
    {
      name: "Discussion Thread Student 1",
      email: "discussion-thread-student1@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Discussion Thread Student 2",
      email: "discussion-thread-student2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Discussion Thread Instructor",
      email: "discussion-thread-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
});

test.describe("Discussion Thread Page", () => {
  test.describe.configure({ mode: "serial" });
  test("A student can view the discussion feed", async ({ page }) => {
    await loginAsUser(page, student1!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await expect(page.getByRole("heading", { name: "Discussion Feed" })).toBeVisible();
    await expect(page.getByRole("link").filter({ hasText: "New Thread" })).toBeVisible();
    await expect(page.getByText("No threads match your criteria.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unanswered Questions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Answered Questions", exact: true })).toBeVisible();
    await argosScreenshot(page, "Discussion Thread Page");
  });
  test("A student can view the create new thread form and create a new private thread", async ({ page }) => {
    await loginAsUser(page, student1!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await page.getByRole("link").filter({ hasText: "New Thread" }).click();
    await argosScreenshot(page, "Create New Thread Form");
    await expect(page.getByRole("heading", { name: "New Discussion Thread" })).toBeVisible();
    await expect(page.getByText("Topic")).toBeVisible();
    // await expect(page.getByText("Assignments", { exact: true })).toBeVisible(); // Too annoying to test
    await expect(page.getByText("Questions and notes about assignments.")).toBeVisible();
    // await expect(page.getByText("Logistics")).toBeVisible(); // Too annoying to test
    await expect(page.getByText("Anything else about the class")).toBeVisible();
    // await expect(page.getByText("Readings")).toBeVisible(); // Too annoying to test
    await expect(page.getByText("Follow-ups and discussion of assigned and optional readings")).toBeVisible();
    // await expect(page.getByText("Memes")).toBeVisible(); // Too annoying to test
    await expect(page.getByText("#random")).toBeVisible();
    await expect(page.getByText("Post Type")).toBeVisible();
    await expect(page.getByText("Question", { exact: true })).toBeVisible();
    await expect(page.getByText("If you need an answer")).toBeVisible();
    await expect(page.getByText("Note", { exact: true })).toBeVisible();
    await expect(page.getByText("If you do not need an answer")).toBeVisible();
    await expect(page.getByText("Post Visibility", { exact: true })).toBeVisible();
    await expect(page.getByText("Entire Class", { exact: true })).toBeVisible();
    await expect(page.getByText("Fastest response - other students can provide support.")).toBeVisible();
    await expect(page.getByText("Staff only", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Only course staff can see this post. Good if you need to share private assignment details.")
    ).toBeVisible();
    await expect(page.getByText("Post Anonymity", { exact: true })).toBeVisible();
    await expect(page.getByText("Post with your name", { exact: true })).toBeVisible();
    await expect(page.getByText("Your name will be displayed to other students.")).toBeVisible();
    await expect(page.getByText("Use your pseudonym")).toBeVisible();
    await expect(
      page.getByText(
        `Students will see your pseudonym (${student1?.public_profile_name}), course staff will always see your real name.`
      )
    ).toBeVisible();
    await expect(page.getByText("A short, descriptive subject for your post. Be specific.")).toBeVisible();
    await expect(page.getByText("Description", { exact: true })).toBeVisible();
    await expect(page.getByText("A detailed description of your post. Be specific.")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Submit" })).toBeVisible();

    // Test the form with a private thread
    await page.getByText("Question", { exact: true }).click();
    await page.getByText("Follow-ups and discussion of assigned and optional readings").click();
    await page.getByText("Staff only", { exact: true }).click();
    await page.getByText("Post with your name", { exact: true }).click();
    await page.getByRole("textbox", { name: "subject" }).fill("Is my answer for HW1 Q1 correct?");
    await page
      .locator('textarea.w-md-editor-text-input[spellcheck="false"]')
      .fill("01001000 01100101 01101100 01101100 01101111 00100000 01010111 01101111 01110010 01101100 01100100");
    await page.getByRole("button").filter({ hasText: "Submit" }).click();
    await expect(page.getByText("0 replies")).toBeVisible();
    await expect(page.getByRole("link", { name: "#1 Is my answer for HW1 Q1 correct?" })).toBeVisible();
    await expect(page.getByText("Viewable by poster and staff only")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).toBeVisible();
    await expect(page.getByRole("heading", { name: student1?.private_profile_name })).toBeVisible();
  });

  test("Another student cannot view a private thread", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await expect(page.getByRole("link", { name: "#1 Is my answer for HW1 Q1 correct?" })).not.toBeVisible();
    await expect(page.getByText("Viewable by poster and staff only")).not.toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: student1?.private_profile_name })).not.toBeVisible();
  });

  test("Another student creates a public thread", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await page.getByRole("link").filter({ hasText: "New Thread" }).click();
    // Test the form with a public thread
    await page.getByText("Anything else about the class").click();
    await page.getByText("Note", { exact: true }).click();
    await page.getByText("Entire Class", { exact: true }).click();
    await page.getByText("Use your pseudonym").click();
    await page.getByRole("textbox", { name: "subject" }).fill("JAVA SUCKS");
    // Freshmen will abuse Pawtograder's privacy features and engage in unprofessional conduct.
    await page
      .locator('textarea.w-md-editor-text-input[spellcheck="false"]')
      .fill(
        "IT'S PREHISTORIC TRASH. KOTLIN IS LITERALLY SO MUCH BETTER SMH. NULL SAFETY, TYPE INFERENCE, AND FIRST-CLASS FUNCTIONS. THE SYLLABUS IS A JOKE AND I REGRET TAKING THIS CLASS. I WILL GIVE THIS CLASS A HORRIBLE REVIEW ON TRACE."
      );
    await page.getByRole("button").filter({ hasText: "Submit" }).click();
    await expect(page.getByText("0 replies")).toBeVisible();
    await expect(page.getByRole("link", { name: "JAVA SUCKS" })).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).toBeVisible();
    await expect(page.getByRole("heading", { name: student2?.public_profile_name })).toBeVisible();
  });

  test("An instructor can view all threads and reply to them", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    // Check that the threads are visible
    await page.waitForURL("**/discussion");
    await expect(page.getByRole("link", { name: "#1 Is my answer for HW1 Q1" }).nth(1)).toBeVisible();
    await expect(page.getByRole("link", { name: "JAVA SUCKS" })).toBeVisible();
    // Check that the instructor can reply to the private thread
    await page.getByRole("link", { name: "#1 Is my answer for HW1 Q1" }).nth(1).click();
    await expect(page.getByRole("button").filter({ hasText: "Watch" })).toBeVisible();
    await page.getByRole("button", { name: "Reply" }).click();
    await page.getByPlaceholder("Reply...").fill("Yes.");
    await page.getByRole("button").filter({ hasText: "Send" }).click();
    //Wait for the form to disappear
    await expect(page.getByText("Enter to send")).not.toBeVisible();
    await expect(page.getByText(instructor?.private_profile_name ?? "")).toBeVisible(); //Not needed, races with removing the reply form
    await expect(page.getByText("Yes.")).toBeVisible();
    await expect(page.getByText("Reply")).toBeVisible();
    await expect(page.getByText("Edit")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).toBeVisible();
    // Check that the instructor can reply to the public thread
    await page.getByRole("link", { name: "JAVA SUCKS" }).click();
    await expect(page.getByText("I WILL GIVE THIS CLASS A HORRIBLE REVIEW ON TRACE.")).toBeVisible(); //Wait for the page to change
    await expect(page.getByRole("button").filter({ hasText: "Watch" })).toBeVisible();
    await page.getByRole("button", { name: "Reply" }).click();
    await page
      .getByPlaceholder("Reply...")
      .fill(
        "Java has had support for functions through lambda expressions for a while now, all the way back from Java 8. It also has lots of documentation and tutorials for new learners. If it's good enough for Netflix's backend through Spring Boot, it's good enough for the purposes of this class. We can schedule a private meeting to continue discussing your personal grievances with the course."
      );
    await page.getByRole("button").filter({ hasText: "Send" }).click();
    //Wait for the form to disappear
    await expect(page.getByText("Enter to send")).not.toBeVisible();
    await expect(page.getByText(instructor?.private_profile_name ?? "")).toBeVisible();
    await expect(
      page.getByText(
        "Java has had support for functions through lambda expressions for a while now, all the way back from Java 8. It also has lots of documentation and tutorials for new learners. If it's good enough for Netflix's backend through Spring Boot, it's good enough for the purposes of this class. We can schedule a private meeting to continue discussing your personal grievances with the course."
      )
    ).toBeVisible();
    await expect(page.getByText("Reply")).toBeVisible();
    await expect(page.getByText("Edit")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).toBeVisible();
    await argosScreenshot(page, "After Instructor Replied to Public Thread");
  });
});

test.describe("Custom Discussion Topics", () => {
  test.describe.configure({ mode: "serial" });

  test("An instructor can view the discussion topics management page", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    // Navigate to Course Settings > Discussion Topics
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Discussion Topics" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Discussion Topics" }).click();
    await page.waitForURL("**/manage/discussion-topics");

    // Verify the page header and description
    await expect(page.getByRole("heading", { name: "Discussion Topics" })).toBeVisible();
    await expect(
      page.getByText("Manage discussion topics for your course. Students use topics to categorize their posts.")
    ).toBeVisible();

    // Verify the Create Topic button is visible
    await expect(page.getByRole("button", { name: "Create Topic" })).toBeVisible();

    // Verify all 4 default topics are displayed with correct details
    // Topic 1: Assignments (orange)
    await expect(page.getByText("Assignments", { exact: true })).toBeVisible();
    await expect(page.getByText("Questions and notes about assignments.")).toBeVisible();
    await expect(page.getByText("Ordinal: 1")).toBeVisible();

    // Topic 2: Logistics (red)
    await expect(page.getByText("Logistics", { exact: true })).toBeVisible();
    await expect(page.getByText("Anything else about the class")).toBeVisible();
    await expect(page.getByText("Ordinal: 2")).toBeVisible();

    // Topic 3: Readings (blue)
    await expect(page.getByText("Readings", { exact: true })).toBeVisible();
    await expect(page.getByText("Follow-ups and discussion of assigned and optional readings")).toBeVisible();
    await expect(page.getByText("Ordinal: 3")).toBeVisible();

    // Topic 4: Memes (purple)
    await expect(page.getByText("Memes", { exact: true })).toBeVisible();
    await expect(page.getByText("#random")).toBeVisible();
    await expect(page.getByText("Ordinal: 4")).toBeVisible();

    // Verify all default topics have the "Default" badge with lock icon
    const defaultBadges = page.getByText("Default", { exact: true });
    await expect(defaultBadges).toHaveCount(4);

    // Verify all default topics show the "cannot be modified" message
    const cannotBeModifiedMessages = page.getByText("Default topics cannot be modified");
    await expect(cannotBeModifiedMessages).toHaveCount(4);

    await argosScreenshot(page, "Discussion Topics Management Page");
  });

  test("Custom discussion topic lifecycle: create, edit, verify visibility, and delete", async ({ page }) => {
    // ===== STEP 1: Create a custom discussion topic =====
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/discussion-topics`);
    await page.waitForURL("**/manage/discussion-topics");

    // Click Create Topic button
    await page.getByRole("button", { name: "Create Topic" }).click();

    // Verify the modal opened
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Create New Discussion Topic")).toBeVisible();

    // Fill in the form
    await page.getByRole("textbox", { name: "Topic Name" }).fill("Homework 1 Questions");
    await page.locator("textarea").fill("Ask questions about Homework 1 here");

    // Select a color (green)
    await page.locator('select[name="color"]').selectOption("green");

    // Submit the form
    await page.getByRole("button", { name: "Create Topic" }).click();

    // Wait for the modal to close and verify the topic was created
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("Homework 1 Questions", { exact: true })).toBeVisible();
    await expect(page.getByText("Ask questions about Homework 1 here")).toBeVisible();

    await argosScreenshot(page, "After Creating Custom Topic");

    // ===== STEP 2: Edit the custom discussion topic =====
    // Find and click the Edit button for the custom topic
    const customTopicRowForEdit = page.locator("div").filter({ hasText: "Homework 1 Questions" }).first();
    await customTopicRowForEdit.getByRole("button", { name: "Edit" }).click();

    // Verify the edit modal opened
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Edit Discussion Topic")).toBeVisible();

    // Change the topic name
    await page.getByRole("textbox", { name: "Topic Name" }).clear();
    await page.getByRole("textbox", { name: "Topic Name" }).fill("HW1 Discussion");

    // Submit the form
    await page.getByRole("button", { name: "Update Topic" }).click();

    // Wait for the modal to close and verify the topic was updated
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("HW1 Discussion", { exact: true })).toBeVisible();

    await argosScreenshot(page, "After Editing Custom Topic");

    // ===== STEP 3: Verify custom topic appears in new thread form =====
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await page.getByRole("link").filter({ hasText: "New Thread" }).click();

    // Verify the custom topic appears in the topic selector
    await expect(page.getByText("HW1 Discussion", { exact: true })).toBeVisible();
    await expect(page.getByText("Ask questions about Homework 1 here")).toBeVisible();

    await argosScreenshot(page, "New Thread Form With Custom Topic");

    // ===== STEP 4: Verify custom topic appears in thread list filter =====
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");

    // Open the filter menu
    await page.getByTestId("filter-threads-button").click();

    // Open the filter dropdown
    await page.getByTestId("filter-dropdown").click();

    // Verify the custom topic appears in the filter options
    await expect(page.getByRole("option", { name: "HW1 Discussion", exact: true })).toBeVisible();

    // ===== STEP 5: Delete the custom discussion topic (as instructor) =====
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/discussion-topics`);
    await page.waitForURL("**/manage/discussion-topics");

    // Find and click the Delete button for the custom topic
    const customTopicRowForDelete = page.locator("div").filter({ hasText: "HW1 Discussion" }).first();
    await customTopicRowForDelete.getByRole("button", { name: "Delete" }).click();

    // Confirm the deletion in the popconfirm dialog
    await expect(page.getByText("Delete Topic")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();

    // Verify the topic was deleted
    await expect(page.getByText("HW1 Discussion", { exact: true })).not.toBeVisible();

    await argosScreenshot(page, "After Deleting Custom Topic");
  });

  test("Default topics cannot be edited or deleted", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/manage/discussion-topics`);
    await page.waitForURL("**/manage/discussion-topics");

    // Define all default topics to test
    const defaultTopics = ["Assignments", "Logistics", "Readings", "Memes"];

    for (const topicName of defaultTopics) {
      // Find each default topic row
      const defaultTopicRow = page.locator("div").filter({ hasText: topicName }).first();

      // Verify Edit and Delete buttons are not present for default topics
      await expect(defaultTopicRow.getByRole("button", { name: "Edit" })).not.toBeVisible();
      await expect(defaultTopicRow.getByRole("button", { name: "Delete" })).not.toBeVisible();
    }

    // Verify all 4 "cannot be modified" messages are shown (one per default topic)
    const cannotBeModifiedMessages = page.getByText("Default topics cannot be modified");
    await expect(cannotBeModifiedMessages).toHaveCount(4);

    // Verify all 4 "Default" badges with lock icons are present
    const defaultBadges = page.getByText("Default", { exact: true });
    await expect(defaultBadges).toHaveCount(4);

    await argosScreenshot(page, "Default Topics Cannot Be Modified");
  });
});
