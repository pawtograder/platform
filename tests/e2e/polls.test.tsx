import { expect, test } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, supabase } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

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

const seedPoll = async (
  course: Course,
  instructor: User,
  overrides: Record<string, any>,
  selectFields = "id"
): Promise<{ id: string }> => {
  const { data, error } = await supabase
    .from("live_polls")
    .insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      question: samplePollQuestion,
      is_live: false,
      require_login: false,
      deactivates_at: null,
      ...overrides
    })
    .select(selectFields)
    .single();

  if (error || !data) {
    throw new Error(`Failed to seed poll: ${error?.message}`);
  }

  const id = (data as any)?.id;
  if (typeof id !== "string") {
    throw new Error("Failed to seed poll: missing id");
  }
  return { id };
};

test.describe("Polls", () => {
  let course: Course;
  let student: User;
  let instructor: User;

  const clearPolls = async () => {
    const { data: polls, error } = await supabase.from("live_polls").select("id").eq("class_id", course.id);
    if (error) {
      throw new Error(`Failed to fetch polls: ${error.message}`);
    }
    const ids = (polls ?? []).map((p) => p.id);
    if (!ids.length) return;

    const { error: responsesError } = await supabase.from("live_poll_responses").delete().in("live_poll_id", ids);
    const { error: pollsError } = await supabase.from("live_polls").delete().in("id", ids);

    const deleteErrors = [
      { table: "live_poll_responses", error: responsesError },
      { table: "live_polls", error: pollsError }
    ].filter(({ error }) => error);

    if (deleteErrors.length) {
      const details = deleteErrors.map(({ table, error }) => `${table}: ${error?.message}`).join("; ");
      throw new Error(`Failed to clear polls: ${details}`);
    }
  };

  test.beforeAll(async () => {
    course = await createClass();
    const users = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Poll Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Poll Instructor", useMagicLink: true }
    ]);
    [student, instructor] = users;
  });

  test.beforeEach(async () => {
    await clearPolls();
  });

  test("student sees empty state when no live polls exist", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    await expect(page.getByRole("heading", { name: "No Live Polls Available" })).toBeVisible();
    await expect(page.getByText("There are currently no live polls available for this course.")).toBeVisible();
  });

  // TODO: Possible vulnerability to flakiness, check issue and reduce the time limit for the check
  test("student sees a poll go live without refreshing", async ({ page }) => {
    const poll = await seedPoll(course, instructor, {
      is_live: false,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Real-time Poll" }]
      }
    });

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    const emptyHeading = page.getByRole("heading", { name: "No Live Polls Available" });
    await expect(emptyHeading).toBeVisible();

    // Wait for realtime connection to be established before updating database
    await expect(
      page.getByRole("note", { name: "Realtime connection status: All realtime connections active" })
    ).toBeVisible({ timeout: 10000 });

    // Give subscription a moment to fully register
    await page.waitForTimeout(1000);

    const { error } = await supabase.from("live_polls").update({ is_live: true }).eq("id", poll.id);
    if (error) {
      throw new Error(`Failed to set poll live for real-time test: ${error.message}`);
    }

    await expect
      .poll(
        async () => {
          try {
            return await page.getByRole("row", { name: /Real-time Poll/i }).isVisible();
          } catch {
            return false;
          }
        },
        { timeout: 40000, message: "poll row should appear without refresh" }
      )
      .toBe(true);

    await expect(emptyHeading).toBeHidden();
  });

  test("student sees active poll with answer action", async ({ page }) => {
    await seedPoll(course, instructor, {
      is_live: true,
      require_login: false,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Active Poll" }] }
    });

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    const pollRow = page.getByRole("row", { name: /active poll/i });
    await expect(pollRow).toBeVisible();
    await expect(pollRow.getByRole("button", { name: /answer poll/i })).toBeVisible();
  });

  test("instructor sees empty manage polls state", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    await expect(page.getByRole("heading", { name: "Manage Polls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No polls yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: /\+ Create Poll/ })).toBeVisible();
  });

  test("visual builder modal updates poll question JSON", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls/new`);

    await page.getByRole("button", { name: /open visual builder/i }).click();

    const promptInput = page.getByPlaceholder("Enter your poll question...");
    await expect(promptInput).toHaveValue("Which topic should we review next?");

    await promptInput.fill("Builder Prompt");
    await page.getByRole("button", { name: /use this poll/i }).click();

    const questionTextarea = page.getByRole("textbox").first();
    await expect(questionTextarea).toHaveValue(/Builder Prompt/);
  });

  test("instructor sees live and closed polls with filters", async ({ page }) => {
    await seedPoll(course, instructor, {
      is_live: true,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Live Poll Question" }]
      }
    });

    await seedPoll(course, instructor, {
      is_live: false,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Closed Poll Question" }]
      }
    });

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
    await seedPoll(course, instructor, {
      is_live: false,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Hidden Closed Poll" }]
      }
    });

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    await expect(page.getByRole("heading", { name: "No Live Polls Available" })).toBeVisible();
    await expect(page.getByText("Hidden Closed Poll")).not.toBeVisible();
  });

  test("student only sees the most recent live poll", async ({ page }) => {
    const olderCreatedAt = "2025-01-01T00:00:00.000Z";
    const newerCreatedAt = "2025-02-01T00:00:00.000Z";

    const older = await seedPoll(course, instructor, {
      is_live: true,
      created_at: olderCreatedAt,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Older Live Poll" }] }
    });

    await seedPoll(course, instructor, {
      is_live: true,
      created_at: newerCreatedAt,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Newer Live Poll" }] }
    });

    // Mimic behavior where starting a newer poll closes the prior live poll
    await supabase.from("live_polls").update({ is_live: false, deactivates_at: newerCreatedAt }).eq("id", older.id);

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    await expect(page.getByText("Newer Live Poll")).toBeVisible();
    await expect(page.getByText("Older Live Poll")).not.toBeVisible();
    await expect(page.getByRole("row", { name: /Newer Live Poll/i })).toHaveCount(1);
  });

  test("instructor sees poll actions menu items", async ({ page }) => {
    await seedPoll(course, instructor, {
      is_live: true,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Menu Poll Question" }]
      }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /Menu Poll Question/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();

    await expect(page.getByRole("menuitem", { name: /Close Poll|Open Poll/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /View Poll/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Delete Poll/i })).toBeVisible();
  });

  test("instructor 'View Poll' opens responses page", async ({ page }) => {
    const poll = await seedPoll(course, instructor, {
      is_live: true,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "View Poll Question" }]
      }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /View Poll Question/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /View Poll/i }).click();

    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/polls/${poll.id}/responses`));
  });

  test("start/stop poll toggles status badge and button label", async ({ page }) => {
    const poll = await seedPoll(course, instructor, {
      is_live: false,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Toggle Poll Question" }]
      }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /Toggle Poll Question/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /Open Poll/i }).click();

    await expect
      .poll(async () => {
        const { data } = await supabase.from("live_polls").select("is_live").eq("id", poll.id).maybeSingle();
        return data?.is_live;
      })
      .toBe(true);

    await page.reload();
    const liveRow = page.getByRole("row", { name: /Toggle Poll Question/i });
    await expect(liveRow.getByText(/^Live$/)).toBeVisible();

    await liveRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /Close Poll/i }).click();

    await expect
      .poll(async () => {
        const { data } = await supabase.from("live_polls").select("is_live").eq("id", poll.id).maybeSingle();
        return data?.is_live;
      })
      .toBe(false);

    await page.reload();
    const closedRow = page.getByRole("row", { name: /Toggle Poll Question/i });
    await expect(closedRow.getByText(/^Closed$/)).toBeVisible();
  });

  test("anonymous visitor must log in to answer a require-login poll", async ({ page }) => {
    await seedPoll(course, instructor, {
      is_live: true,
      require_login: true,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Login Required Poll" }]
      }
    });

    await page.goto(`/poll/${course.id}`);

    await expect(page.getByText(/You need to be logged in to respond to this poll/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign in/i })).toBeVisible();
  });

  test("student clicking Answer Poll opens poll page", async ({ page }) => {
    await seedPoll(course, instructor, {
      is_live: true,
      require_login: false,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Answerable Poll" }] }
    });

    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/polls`);

    const answerButton = page.getByRole("button", { name: /Answer Poll/i });
    const [pollPage] = await Promise.all([page.waitForEvent("popup"), answerButton.click()]);
    await pollPage.waitForLoadState("domcontentloaded");
    await expect(pollPage).toHaveURL(new RegExp(`/poll/${course.id}`));
  });

  test("student submits a require-login poll and response is stored", async ({ page }) => {
    const poll = await seedPoll(course, instructor, {
      is_live: true,
      require_login: true,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Submit Poll Question" }]
      }
    });

    await loginAsUser(page, student, course);
    await page.goto(`/poll/${course.id}`);

    await expect(page.getByText("Submit Poll Question")).toBeVisible();
    const blueRadio = page.getByRole("radio", { name: "Blue" });
    await blueRadio.evaluate((el: HTMLInputElement) => el.click());
    await expect(blueRadio).toBeChecked();
    await page.getByRole("button", { name: /Complete|Submit/i }).click();

    await expect(page.getByRole("heading", { name: /Thank You!/i })).toBeVisible();

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("live_poll_responses")
            .select("public_profile_id, response")
            .eq("live_poll_id", poll.id)
            .maybeSingle();
          return data;
        },
        { timeout: 5000, message: "response should be recorded" }
      )
      .toMatchObject({ public_profile_id: student.public_profile_id, response: { poll_question_0: "Blue" } });
  });

  test("responses page start/stop button updates poll live state", async ({ page }) => {
    const poll = await seedPoll(course, instructor, {
      is_live: false,
      question: {
        ...samplePollQuestion,
        elements: [{ ...samplePollQuestion.elements[0], title: "Responses Toggle Poll" }]
      }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls/${poll.id}/responses`);

    const startButton = page.getByRole("button", { name: /Start Poll/i });
    await expect(startButton).toBeVisible();
    await startButton.click();

    await expect
      .poll(async () => {
        const { data } = await supabase.from("live_polls").select("is_live").eq("id", poll.id).maybeSingle();
        return data?.is_live;
      })
      .toBe(true);

    // Wait for button text to update - use data-testid for more reliable selection
    await expect(page.getByTestId("toggle-poll-button")).toHaveText(/Stop Poll/i);
    await expect(page.getByRole("button", { name: /Stop Poll/i })).toBeVisible();

    await page.getByRole("button", { name: /Stop Poll/i }).click();
    await expect
      .poll(async () => {
        const { data } = await supabase.from("live_polls").select("is_live").eq("id", poll.id).maybeSingle();
        return data?.is_live;
      })
      .toBe(false);
    await expect(page.getByRole("button", { name: /Start Poll/i })).toBeVisible();
  });

  test("public poll page shows empty state when no live poll exists", async ({ page }) => {
    await page.goto(`/poll/${course.id}`);

    await expect(page.getByRole("heading", { name: "No Live Poll Available" })).toBeVisible();
    await expect(page.getByText("There is currently no live poll available for this course.")).toBeVisible();
  });

  test.skip("instructor can delete a poll from manage table", async ({ page }) => {
    await seedPoll(course, instructor, {
      is_live: false,
      question: { ...samplePollQuestion, elements: [{ ...samplePollQuestion.elements[0], title: "Deletable Poll" }] }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/polls`);

    const pollRow = page.getByRole("row", { name: /Deletable Poll/i });
    await pollRow.getByRole("button", { name: /Poll actions/i }).click();
    await page.getByRole("menuitem", { name: /Delete Poll/i }).click();

    // Confirm deletion (toast/confirm pattern varies; validate by reloading and checking absence)
    const confirmButton = page.getByRole("button", { name: /Delete Poll|Delete/i }).first();
    await confirmButton.click();

    await expect(page.getByRole("row", { name: /Deletable Poll/i })).toHaveCount(0);
  });
});
