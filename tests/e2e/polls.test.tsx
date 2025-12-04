import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

const samplePollQuestion = {
  elements: [
    {
      type: "radiogroup",
      name: "poll_question_0",
      title: "Favorite Color?",
      choices: ["Red", "Blue", "Green"]
    }
  ]
};

test.describe("Polls", () => {
  test("student sees empty state when no live polls exist", async ({ page }) => {
    const course = await createClass();
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Poll Student", useMagicLink: true }
    ]);

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    await expect(page.getByRole("heading", { name: "No Live Polls Available" })).toBeVisible();
    await expect(page.getByText("There are currently no live polls available for this course.")).toBeVisible();
  });

  test("student sees active poll with answer action", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Active Poll Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Active Poll Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("live_polls").insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: samplePollQuestion,
      is_live: true,
      require_login: false,
      deactivates_at: null
    });
    if (error) {
      throw new Error(`Failed to seed live poll: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    const pollRow = page.getByRole("row", { name: /favorite color\?/i });
    await expect(pollRow).toBeVisible();
    await expect(pollRow.getByRole("button", { name: /answer poll/i })).toBeVisible();
  });

  test("instructor sees empty manage polls state", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Placeholder Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Poll Manager", useMagicLink: true }
    ]);

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    await expect(page.getByRole("heading", { name: "Manage Polls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No polls yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: /\+ Create Poll/ })).toBeVisible();
  });

  test("instructor sees live and closed polls with filters", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Poll Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Poll Instructor", useMagicLink: true }
    ]);

    const livePoll = {
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Live Poll Question" }] },
      is_live: true,
      require_login: false,
      deactivates_at: null
    };

    const closedPoll = {
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Closed Poll Question" }] },
      is_live: false,
      require_login: false,
      deactivates_at: null
    };

    const { error } = await supabase.from("live_polls").insert([livePoll, closedPoll]);
    if (error) {
      throw new Error(`Failed to seed polls: ${error.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const liveRow = page.getByRole("row", { name: /Live Poll Question/i });
    const closedRow = page.getByRole("row", { name: /Closed Poll Question/i });

    const liveStatusCell = liveRow.getByRole("cell").nth(1);
    const closedStatusCell = closedRow.getByRole("cell").nth(1);

    await expect(liveStatusCell.getByText(/^Live$/)).toBeVisible();
    await expect(closedStatusCell.getByText(/^Closed$/)).toBeVisible();

    await page.getByRole("button", { name: /live/i }).click();
    await expect(liveRow).toBeVisible();
    await expect(closedRow).not.toBeVisible();

    await page.getByRole("button", { name: /closed/i }).click();
    await expect(closedRow).toBeVisible();
    await expect(liveRow).not.toBeVisible();
  });
});
