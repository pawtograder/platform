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

  test("student only sees live polls (closed polls are hidden)", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Closed Poll Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Closed Poll Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("live_polls").insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Hidden Closed Poll" }] },
      is_live: false,
      require_login: false,
      deactivates_at: null
    });
    if (error) {
      throw new Error(`Failed to seed closed poll: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    await expect(page.getByRole("heading", { name: "No Live Polls Available" })).toBeVisible();
    await expect(page.getByText("Hidden Closed Poll")).not.toBeVisible();
  });

  test("instructor sees poll actions menu items", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Poll Menu Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Poll Menu Instructor", useMagicLink: true }
    ]);

    const { data: poll, error } = await supabase
      .from("live_polls")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Menu Poll Question" }] },
        is_live: true,
        require_login: false,
        deactivates_at: null
      })
      .select("id")
      .single();
    if (error || !poll) {
      throw new Error(`Failed to seed poll for menu: ${error?.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /Menu Poll Question/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();

    await expect(page.getByRole("menuitem", { name: /Close Poll|Open Poll/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /View Poll/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Delete Poll/i })).toBeVisible();
  });

  test("instructor 'View Poll' opens responses page", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "View Poll Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "View Poll Instructor", useMagicLink: true }
    ]);

    const { data: poll, error } = await supabase
      .from("live_polls")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "View Poll Question" }] },
        is_live: true,
        require_login: false,
        deactivates_at: null
      })
      .select("id")
      .single();
    if (error || !poll) {
      throw new Error(`Failed to seed poll for view: ${error?.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /View Poll Question/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /View Poll/i }).click();

      await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/polls/${poll.id}/responses`));
    });

  test("start/stop poll toggles status badge and button label", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Toggle Poll Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Toggle Poll Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("live_polls").insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Toggle Poll Question" }] },
      is_live: false,
      require_login: false,
      deactivates_at: null
    });
    if (error) {
      throw new Error(`Failed to seed poll for toggle: ${error.message}`);
    }

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /Toggle Poll Question/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /Open Poll/i }).click();

    await expect(pollRow.getByText(/^Live$/)).toBeVisible();

    await pollRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /Close Poll/i }).click();

    await expect(pollRow.getByText(/^Closed$/)).toBeVisible();
  });

  test("anonymous visitor must log in to answer a require-login poll", async ({ page }) => {
    const course = await createClass();
    const [, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Anon Student Placeholder", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Anon Poll Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("live_polls").insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Login Required Poll" }] },
      is_live: true,
      require_login: true,
      deactivates_at: null
    });
    if (error) {
      throw new Error(`Failed to seed require-login poll: ${error.message}`);
    }

    // Visit public poll endpoint without logging in
    await page.goto(`/poll/${course.id}`);

    await expect(page.getByText(/You need to be logged in to respond to this poll/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign in/i })).toBeVisible();
  });

  test("student clicking Answer Poll opens poll page", async ({ page }) => {
    const course = await createClass();
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Answer Poll Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Answer Poll Instructor", useMagicLink: true }
    ]);

    const { error } = await supabase.from("live_polls").insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Answerable Poll" }] },
      is_live: true,
      require_login: false,
      deactivates_at: null
    });
    if (error) {
      throw new Error(`Failed to seed poll for answer action: ${error.message}`);
    }

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    const answerButton = page.getByRole("button", { name: /Answer Poll/i });
    const [pollPage] = await Promise.all([page.waitForEvent("popup"), answerButton.click()]);
    await pollPage.waitForLoadState("domcontentloaded");
    await expect(pollPage).toHaveURL(new RegExp(`/poll/${course.id}`));
  });
});
