import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import { createClass, createUsersInClass, loginAsUser, supabase, TestingUser } from "./TestingUtils";
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
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student1, student2, instructor]);
});
test.describe("Discussion Thread Page", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);
  test("A student can view the discussion feed", async ({ page }) => {
    await loginAsUser(page, student1!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await expect(page.getByRole("heading", { name: "Pinned Posts" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse Topics" })).toBeVisible();
    await expect(page.getByPlaceholder("Search posts")).toBeVisible();
    await expect(page.getByText("New Post")).toBeVisible();
    await expect(
      page.getByText("Your feed is empty. Follow a topic (Browse Topics) or follow a post to see it here.")
    ).toBeVisible();
    await argosScreenshot(page, "Discussion Thread Page");
  });
  test("A student can view the create new thread form and create a new private thread", async ({ page }) => {
    await loginAsUser(page, student1!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    // Wait for the page to stabilize
    await expect(page.getByRole("heading", { name: "Pinned Posts" })).toBeVisible();
    await page.getByText("New Post").click();
    // Wait for the form to appear
    await expect(page.getByRole("heading", { name: "New Discussion Thread" })).toBeVisible();
    await argosScreenshot(page, "Create New Thread Form");
    await expect(page.getByText("Topic", { exact: true })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Is my answer for HW1 Q1 correct?" })).toBeVisible();
    await expect(page.getByText("Viewable by poster and staff only")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unfollow" })).toBeVisible();
    await expect(page.getByRole("heading", { name: student1?.private_profile_name })).toBeVisible();
  });

  test("Another student cannot view a private thread", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await expect(page.getByText("Is my answer for HW1 Q1 correct?")).not.toBeVisible();
    await expect(page.getByText("Viewable by poster and staff only")).not.toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unfollow" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: student1?.private_profile_name })).not.toBeVisible();
  });

  test("Another student creates a public thread", async ({ page }) => {
    await loginAsUser(page, student2!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    // Wait for the page to stabilize
    await expect(page.getByRole("heading", { name: "Pinned Posts" })).toBeVisible();
    await page.getByText("New Post").click();
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
    await expect(page.getByRole("heading", { name: "JAVA SUCKS" })).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unfollow" })).toBeVisible();
    await expect(page.getByRole("heading", { name: student2?.public_profile_name })).toBeVisible();
  });

  test("An instructor can view all threads and reply to them", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    // Check that the threads are visible
    await page.waitForURL("**/discussion");
    await expect(page.getByText("Is my answer for HW1 Q1 correct?")).toBeVisible();

    // Check that the instructor can reply to the private thread
    await page.getByText("Is my answer for HW1 Q1 correct?").click();
    await expect(page.getByRole("button").filter({ hasText: "Follow" })).toBeVisible();
    await page.getByRole("button", { name: "Reply" }).click();
    await page.getByPlaceholder("Reply...").fill("Yes.");
    await page.getByRole("button").filter({ hasText: "Send" }).click();
    //Wait for the form to disappear
    await expect(page.getByText("Enter to send")).not.toBeVisible();
    await expect(page.getByText(instructor?.private_profile_name ?? "")).toBeVisible(); //Not needed, races with removing the reply form
    await expect(page.getByText("Yes.")).toBeVisible();
    await expect(page.getByText("Reply")).toBeVisible();
    await expect(page.getByText("Edit")).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "Unfollow" })).toBeVisible();

    // Need to go to browse topics to see the thread (because it's public)
    await page.getByRole("link", { name: "Browse Topics" }).click();
    await page.waitForURL("**/discussion?view=browse");
    await page.getByRole("button", { name: "Logistics Follow topic" }).click();
    await expect(page.getByRole("link", { name: "JAVA SUCKS" })).toBeVisible();

    // Check that the instructor can reply to the public thread
    await page.getByRole("link", { name: "JAVA SUCKS" }).click();
    await expect(page.getByText("I WILL GIVE THIS CLASS A HORRIBLE REVIEW ON TRACE.")).toBeVisible(); //Wait for the page to change
    await expect(page.getByRole("button").filter({ hasText: "Follow" })).toBeVisible();
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
    await expect(page.getByRole("button").filter({ hasText: "Unfollow" })).toBeVisible();
    await argosScreenshot(page, "After Instructor Replied to Public Thread");
  });
});

test.describe("Custom Discussion Topics", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);

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

    // Default topics can be edited for icon/default-follow settings
    const editButtons = page.getByRole("button", { name: "Edit" });
    await expect(editButtons).toHaveCount(4);

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

    // Wait for the topic to appear on the page (dialog may linger in webkit due to CSS animation)
    await expect(page.getByText("Homework 1 Questions", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Ask questions about Homework 1 here")).toBeVisible();

    await argosScreenshot(page, "After Creating Custom Topic").catch(() => {});

    // ===== STEP 2: Edit the custom discussion topic =====
    // Find and click the Edit button for the custom topic, within the container for that topic
    const customTopicRowForEdit = page.getByRole("region", { name: "Discussion topic: Homework 1 Questions" });
    await customTopicRowForEdit.getByRole("button", { name: "Edit" }).click();

    // Verify the edit modal opened
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Edit Discussion Topic")).toBeVisible();

    // Change the topic name
    await page.getByRole("textbox", { name: "Topic Name" }).clear();
    await page.getByRole("textbox", { name: "Topic Name" }).fill("HW1 Discussion");

    // Submit the form
    await page.getByRole("button", { name: "Update Topic" }).click();

    // Wait for the topic update to appear (dialog may linger in webkit due to CSS animation)
    await expect(page.getByText("HW1 Discussion", { exact: true })).toBeVisible({ timeout: 30_000 });

    await argosScreenshot(page, "After Editing Custom Topic").catch(() => {});

    // ===== STEP 3: Verify custom topic appears in new thread form =====
    const navRegion = await page.locator("#course-nav");
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await expect(page.getByRole("heading", { name: "Pinned Posts" })).toBeVisible();
    await page.getByText("New Post").click();
    await page.waitForURL("**/discussion/new");

    // Verify the custom topic appears in the topic selector.
    // Topics are loaded asynchronously by the course controller after navigation,
    // so retry until the data arrives.
    await expect(async () => {
      await expect(page.getByText("HW1 Discussion", { exact: true })).toBeVisible();
      await expect(page.getByText("Ask questions about Homework 1 here")).toBeVisible();
    }).toPass({ timeout: 20000 });

    await argosScreenshot(page, "New Thread Form With Custom Topic").catch(() => {});

    // ===== STEP 4: Verify custom topic appears in Browse Topics =====
    await navRegion.getByRole("link").filter({ hasText: "Discussion" }).click();
    await page.waitForURL("**/discussion");
    await page.getByText("Browse Topics", { exact: true }).click();
    await expect(page.getByText("HW1 Discussion", { exact: true })).toBeVisible();

    // ===== STEP 5: Delete the custom discussion topic (as instructor) =====
    await page.getByRole("group").filter({ hasText: "Course Settings" }).locator("div").click();
    await expect(page.getByRole("menuitem", { name: "Discussion Topics" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Discussion Topics" }).click();
    await page.waitForURL("**/manage/discussion-topics");

    // Find and click the Delete button for the custom topic
    const customTopicRowForDelete = page.getByRole("region", { name: "Discussion topic: HW1 Discussion" });
    await customTopicRowForDelete.getByRole("button", { name: "Delete" }).click();

    // Confirm the deletion in the popconfirm dialog
    await page.getByRole("button", { name: "Confirm" }).click();

    // Verify the topic was deleted
    await expect(page.getByText("HW1 Discussion", { exact: true })).not.toBeVisible();

    await argosScreenshot(page, "After Deleting Custom Topic").catch(() => {});
  });
});

test.describe("Discussion duplicate merge (grader)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let dupCourse: Course;
  let dupStudent: TestingUser;
  let dupGrader: TestingUser;

  test.beforeAll(async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    dupCourse = await createClass({ name: `E2E discussion duplicate class ${runId}` });
    [dupStudent, dupGrader] = await createUsersInClass([
      {
        name: "DupMerge Student",
        role: "student",
        class_id: dupCourse.id,
        useMagicLink: true,
        randomSuffix: `dup-stu-${runId}`
      },
      {
        name: "DupMerge Grader",
        role: "grader",
        class_id: dupCourse.id,
        useMagicLink: true,
        randomSuffix: `dup-grd-${runId}`
      }
    ]);
    await supabase.from("users").update({ name: "E2E Dup Grader" }).eq("user_id", dupGrader.user_id);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([dupStudent, dupGrader]);
  });

  test("Grader marks a thread duplicate, student sees banner and notification", async ({ page }) => {
    const { data: topicRow, error: topicErr } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", dupCourse.id)
      .order("ordinal", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (topicErr || !topicRow) {
      throw new Error(topicErr?.message ?? "No discussion topic for duplicate E2E class");
    }

    const { data: origThread, error: origErr } = await supabase
      .from("discussion_threads")
      .insert({
        subject: "E2E Dup Original Subject",
        body: "Original thread body for duplicate merge test.",
        topic_id: topicRow.id,
        is_question: false,
        instructors_only: false,
        author: dupStudent.private_profile_id,
        class_id: dupCourse.id,
        draft: false,
        root_class_id: dupCourse.id
      })
      .select("id")
      .single();
    if (origErr || !origThread) {
      throw new Error(origErr?.message ?? "Failed to insert original thread");
    }

    const { data: dupThread, error: dupErr } = await supabase
      .from("discussion_threads")
      .insert({
        subject: "E2E Dup Duplicate Subject",
        body: "Duplicate thread body.",
        topic_id: topicRow.id,
        is_question: false,
        instructors_only: false,
        author: dupStudent.private_profile_id,
        class_id: dupCourse.id,
        draft: false,
        root_class_id: dupCourse.id
      })
      .select("id")
      .single();
    if (dupErr || !dupThread) {
      throw new Error(dupErr?.message ?? "Failed to insert duplicate thread");
    }

    const { error: replyErr } = await supabase.from("discussion_threads").insert({
      subject: `Re: E2E Dup Duplicate Subject`,
      body: "A reply under the duplicate root before merge.",
      topic_id: topicRow.id,
      is_question: false,
      instructors_only: false,
      author: dupStudent.private_profile_id,
      class_id: dupCourse.id,
      draft: false,
      parent: dupThread.id,
      root: dupThread.id
    });
    if (replyErr) {
      throw new Error(replyErr.message);
    }

    await loginAsUser(page, dupGrader, dupCourse);
    await page.goto(`/course/${dupCourse.id}/discussion/${dupThread.id}`);
    await expect(page.getByRole("heading", { name: "E2E Dup Duplicate Subject" })).toBeVisible();

    await page.getByRole("button", { name: "Mark duplicate" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("textbox").fill(String(origThread.id));
    await page.getByRole("button", { name: "Merge into original" }).click();
    await page.waitForURL(`**/course/${dupCourse.id}/discussion/${origThread.id}`);

    await expect(page.getByRole("heading", { name: "E2E Dup Original Subject" })).toBeVisible();
    await expect(page.getByText("E2E Dup Duplicate Subject")).toBeVisible();
    await expect(page.getByText(/E2E Dup Grader.*marked it as a duplicate/)).toBeVisible();
    await expect(page.getByText("A reply under the duplicate root before merge.")).toBeVisible();

    await loginAsUser(page, dupStudent, dupCourse);
    await page.goto(`/course/${dupCourse.id}/notifications`);
    await expect(
      page.getByText(/E2E Dup Grader marked "E2E Dup Duplicate Subject" as a duplicate of "E2E Dup Original Subject"/)
    ).toBeVisible();
  });
});
