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
    await page.getByRole("link").filter({ hasText: "Discussion" }).click();
    await expect(page.getByRole("heading", { name: "Discussion Feed" })).toBeVisible();
    await expect(page.getByRole("link").filter({ hasText: "New Thread" })).toBeVisible();
    await expect(page.getByPlaceholder("Search threads...")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Filter discussion threads" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Sort discussion threads" })).toBeVisible();
    await expect(page.getByText("No threads match your criteria.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unanswered Questions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Answered Questions", exact: true })).toBeVisible();
    await argosScreenshot(page, "Discussion Thread Page");
  });
  test("A student can view the create new thread form and create a new private thread", async ({ page }) => {
    await loginAsUser(page, student1!, course);
    await page.getByRole("link").filter({ hasText: "Discussion" }).click();
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
    await page.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await expect(page.getByRole("link", { name: "#1 Is my answer for HW1 Q1 correct?" })).not.toBeVisible();
    await expect(page.getByText("Viewable by poster and staff only")).not.toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: student1?.private_profile_name })).not.toBeVisible();
  });

  test("Another student creates a public thread", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    await page.getByRole("link").filter({ hasText: "Discussion" }).click();
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
    await expect(page.getByText(instructor?.private_profile_name ?? "")).toBeVisible();
    await expect(page.getByText("Yes.")).toBeVisible();
    await expect(page.getByText("Reply")).toBeVisible();
    await expect(page.getByText("Edit")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).toBeVisible();
    // Check that the instructor can reply to the public thread
    await page.getByRole("link", { name: "JAVA SUCKS" }).click();
    await expect(page.getByRole("button").filter({ hasText: "Watch" })).toBeVisible();
    await page.getByRole("button", { name: "Reply" }).click();
    await page
      .getByPlaceholder("Reply...")
      .fill(
        "Java has had support for functions through lambda expressions for a while now, all the way back from Java 8. It also has lots of documentation and tutorials for new learners. If it's good enough for Netflix's backend through Spring Boot, it's good enough for the purposes of this class. We can schedule a private meeting to continue discussing your personal grievances with the course."
      );
    await page.getByRole("button").filter({ hasText: "Send" }).click();
    await expect(page.getByText(instructor?.private_profile_name ?? "")).toBeVisible();
    await expect(page.getByText("Yes.")).toBeVisible();
    await expect(page.getByText("Reply")).toBeVisible();
    await expect(page.getByText("Edit")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unwatch" })).toBeVisible();
  });
});
