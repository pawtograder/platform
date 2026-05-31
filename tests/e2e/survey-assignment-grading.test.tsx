import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  formatDateForTest,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";
import type { TablesInsert } from "../../utils/supabase/SupabaseTypes";
import { TEAM_COLLABORATION_SURVEY } from "../fixtures/teamCollaborationSurvey";
import { visualScreenshot } from "./VisualTestUtils";

dotenv.config({ path: ".env.local", quiet: true });

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];
type SurveyInsert = TablesInsert<"surveys">;

/** Use shared team collaboration survey (same as DB seeding) */
const teamCollaborationSurveyJson = TEAM_COLLABORATION_SURVEY;
const TEAM_SURVEY_TITLE = "Week 5 Team Collaboration Survey";
const COURSE_FEEDBACK_SURVEY_TITLE = "General Course Feedback";
const SURVEY_DUE_DATE = new Date("2035-03-15T16:00:00.000Z");
const ASSIGNMENT_DUE_DATE = new Date("2035-03-17T16:00:00.000Z");
const SUBMITTED_AT = new Date("2035-03-10T16:00:00.000Z");

const expectTransparentText = async (page: import("@playwright/test").Page, text: string | RegExp) => {
  await expect(page.locator('[data-visual-test="transparent"]').filter({ hasText: text }).first()).toBeVisible();
};

const buildSurveyPayload = (course: Course, instructor: User, overrides: Partial<SurveyInsert> = {}): SurveyInsert => {
  const { json, ...rest } = overrides;
  return {
    class_id: course.id,
    created_by: instructor.public_profile_id,
    assigned_to_all: true,
    allow_response_editing: false,
    json: json ?? {},
    version: 1,
    status: "draft",
    title: "Survey",
    description: "Description",
    ...rest
  };
};

const seedSurvey = async <T = any,>(
  course: Course,
  instructor: User,
  overrides: Partial<SurveyInsert>,
  selectFields = "id, survey_id"
): Promise<T> => {
  const { data, error } = await supabase
    .from("surveys")
    .insert(buildSurveyPayload(course, instructor, overrides))
    .select(selectFields)
    .single();

  if (error || !data) {
    throw new Error(`Failed to seed survey: ${error?.message}`);
  }

  return data as T;
};

test.describe("Survey Assignment Grading - E2E Screenshots", () => {
  test.describe.configure({ mode: "serial" });

  let course: Course;
  let studentA: User;
  let studentB: User;
  let studentC: User;
  let instructor: User;
  let grader: User;

  const clearCourseSurveys = async () => {
    const { data: surveys, error } = await supabase.from("surveys").select("id").eq("class_id", course.id);
    if (error) throw new Error(`Failed to fetch surveys: ${error.message}`);
    const ids = (surveys ?? []).map((s) => s.id);
    if (!ids.length) return;
    await supabase.from("survey_responses").delete().in("survey_id", ids);
    await supabase.from("survey_assignments").delete().in("survey_id", ids);
    await supabase.from("surveys").delete().in("id", ids);
  };

  test.beforeEach(async () => {
    course = await createClass();
    const users = await createUsersInClass([
      {
        role: "student",
        class_id: course.id,
        name: "Alice Student",
        public_profile_name: "Survey Pseudonym Alice",
        email: `survey-alice-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "student",
        class_id: course.id,
        name: "Bob Student",
        public_profile_name: "Survey Pseudonym Bob",
        email: `survey-bob-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "student",
        class_id: course.id,
        name: "Carol Student",
        public_profile_name: "Survey Pseudonym Carol",
        email: `survey-carol-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "instructor",
        class_id: course.id,
        name: "Survey Instructor",
        public_profile_name: "Survey Pseudonym Instructor",
        email: `survey-instructor-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "grader",
        class_id: course.id,
        name: "Survey Grader",
        public_profile_name: "Survey Pseudonym Grader",
        email: `survey-grader-${course.id}@pawtograder.net`,
        useMagicLink: true
      }
    ]);
    [studentA, studentB, studentC, instructor, grader] = users;
    await clearCourseSurveys();
  });
  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([studentA, studentB, studentC, instructor, grader]);
  });

  test("student views team collaboration survey and takes it", async ({ page }) => {
    // Create a published survey with the team collaboration JSON
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: TEAM_SURVEY_TITLE,
      description: "Please complete this weekly survey about your team collaboration experience.",
      status: "published",
      json: teamCollaborationSurveyJson,
      due_date: SURVEY_DUE_DATE.toISOString()
    });

    await loginAsUser(page, studentA, course);

    // Navigate to the survey list
    await page.goto(`/course/${course.id}/surveys`);
    await expect(page.getByRole("heading", { name: "Course Surveys" })).toBeVisible();
    await expect(page.getByText(TEAM_SURVEY_TITLE)).toBeVisible();
    await expectTransparentText(page, formatDateForTest(SURVEY_DUE_DATE, "America/New_York", "full"));
    await assertStudentPageAccessible(page, "survey assignment grading - survey list");
    await visualScreenshot(page, "Student Survey List - Team Collaboration Survey Available", { skipPreIdle: true });

    const surveyRoot = page.locator(".sd-root-modern");
    const startLink = page.getByRole("link", { name: /Start Survey/i });
    await startLink.click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys/${survey.id}`));
    await expect(surveyRoot.getByRole("group", { name: "This week I have..." })).toBeVisible();
    await visualScreenshot(page, "Student Survey - Page 1 Checkboxes", { skipPreIdle: true });
    // Scan every page of the SurveyJS-driven survey. SurveyJS is excluded
    // from axe in axeStudentA11y.ts (`.sd-root-modern`, `.sv-action`, etc.),
    // so these scans cover everything *around* the survey shell: page
    // chrome, headings, the Pawtograder layout, and the navigation buttons.
    await assertStudentPageAccessible(page, "team collaboration survey page 1 (empty)");

    // Fill page 1 - click on the label text for SurveyJS checkboxes
    await surveyRoot.locator("label").filter({ hasText: "Completed all my assigned tasks" }).click();
    await surveyRoot
      .locator("label")
      .filter({ hasText: "Helped a teammate complete a portion of their task(s)" })
      .click();
    await surveyRoot
      .locator("label")
      .filter({ hasText: "Met live (including Zoom meetings, Discord voicechat, or similar) with my team" })
      .click();
    await surveyRoot
      .locator("label")
      .filter({ hasText: "Opened a Pull Request and asked my team for feedback on my code" })
      .click();
    await expect(
      surveyRoot.getByRole("checkbox", { name: "Completed all my assigned tasks" })
    ).toBeChecked();

    const surveyNext = surveyRoot.getByRole("button", { name: /^Next$/i });
    await surveyNext.click();
    await expect(
      surveyRoot.getByRole("radiogroup", { name: "This week, I knew what I needed to get done" })
    ).toBeVisible();

    // Fill page 2 - first Likert question only (SurveyJS hides native radios; click its label)
    await surveyRoot
      .getByRole("radiogroup", { name: "This week, I knew what I needed to get done" })
      .locator("label")
      .filter({ hasText: /^Strongly agree$/ })
      .click();
    await expect(
      surveyRoot
        .getByRole("radiogroup", { name: "This week, I knew what I needed to get done" })
        .getByRole("radio", { name: "Strongly agree" })
    ).toBeChecked();

    await surveyNext.click();
    await expect(
      surveyRoot.getByRole("radiogroup", { name: "In our team we relied on each other to get the job done." })
    ).toBeVisible();

    await surveyNext.click();
    await expect(surveyRoot.getByRole("group", { name: "My progress this week has been impeded by:" })).toBeVisible();
    await expect(
      surveyRoot.getByRole("textbox", {
        name: "How do you feel about your team's collaboration process in this project? Please reflect in about two sentences."
      })
    ).toBeVisible();
    await visualScreenshot(page, "Student Survey - Page 4 Impediments and Reflection", { skipPreIdle: true });
    await assertStudentPageAccessible(page, "team collaboration survey page 4 (shell)");
  });

  test("student sees survey status banner on submission page", async ({ page }) => {
    // Create an assignment
    const assignment = await insertAssignment({
      due_date: ASSIGNMENT_DUE_DATE.toISOString(),
      class_id: course.id,
      name: "Survey Banner Assignment",
      assignment_slug: `survey-banner-assignment-${course.id}`
    });

    // Create a submission for studentA
    await insertPreBakedSubmission({
      student_profile_id: studentA.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a survey linked to this assignment
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: TEAM_SURVEY_TITLE,
      description: "Complete this survey about your team.",
      status: "published",
      json: teamCollaborationSurveyJson,
      assignment_id: assignment.id,
      due_date: SURVEY_DUE_DATE.toISOString()
    });

    await loginAsUser(page, studentA, course);

    // Navigate to the submission page
    await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions`);

    // Wait for the survey status banner to appear
    await expect(page.getByText(`Survey: ${TEAM_SURVEY_TITLE}`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Pending")).toBeVisible();
    await expect(page.getByText("Take Survey")).toBeVisible();
    await expectTransparentText(page, /Due /);
    await assertStudentPageAccessible(page, "submission page survey pending banner");

    await visualScreenshot(page, "Student Submission Page - Survey Pending Banner");

    // Now submit a response for this student to see the completed state
    const { error: respError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
      response: {
        q1: [1, 3],
        q2: [1, 3],
        q3: 5,
        q4: 3,
        q5: 3,
        q6: 5,
        q7: 3,
        q16: 5,
        q21: 1,
        q23: 5,
        q24: 4,
        q9: [7],
        q15: "Our team collaborates well through regular meetings and code reviews."
      },
      is_submitted: true,
      submitted_at: SUBMITTED_AT.toISOString()
    });
    if (respError) throw new Error(`Failed to insert response: ${respError.message}`);

    // Reload to see the completed status
    await page.reload();
    await expect(page.getByText(`Survey: ${TEAM_SURVEY_TITLE}`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Completed")).toBeVisible();
    await expect(page.getByText("View Response")).toBeVisible();
    await expectTransparentText(page, /Submitted /);
    await assertStudentPageAccessible(page, "submission page survey completed banner");

    await visualScreenshot(page, "Student Submission Page - Survey Completed Banner");
  });

  test("instructor views survey responses and analytics", async ({ page }) => {
    // Create an assignment
    const assignment = await insertAssignment({
      due_date: ASSIGNMENT_DUE_DATE.toISOString(),
      class_id: course.id,
      name: "Survey Responses Assignment",
      assignment_slug: `survey-responses-assignment-${course.id}`
    });

    // Create groups for the assignment with a mentor
    const { data: groupAlpha, error: groupAlphaErr } = await supabase
      .from("assignment_groups")
      .insert({
        assignment_id: assignment.id,
        class_id: course.id,
        name: "Team Alpha",
        mentor_profile_id: grader.private_profile_id
      })
      .select("id")
      .single();
    if (groupAlphaErr || !groupAlpha) throw new Error(`Failed to create group Alpha: ${groupAlphaErr?.message}`);

    const { data: groupBeta, error: groupBetaErr } = await supabase
      .from("assignment_groups")
      .insert({
        assignment_id: assignment.id,
        class_id: course.id,
        name: "Team Beta"
      })
      .select("id")
      .single();
    if (groupBetaErr || !groupBeta) throw new Error(`Failed to create group Beta: ${groupBetaErr?.message}`);

    // Add students to groups
    await supabase.from("assignment_groups_members").insert([
      {
        assignment_group_id: groupAlpha.id,
        profile_id: studentA.private_profile_id,
        assignment_id: assignment.id,
        class_id: course.id,
        added_by: instructor.private_profile_id
      },
      {
        assignment_group_id: groupAlpha.id,
        profile_id: studentB.private_profile_id,
        assignment_id: assignment.id,
        class_id: course.id,
        added_by: instructor.private_profile_id
      },
      {
        assignment_group_id: groupBeta.id,
        profile_id: studentC.private_profile_id,
        assignment_id: assignment.id,
        class_id: course.id,
        added_by: instructor.private_profile_id
      }
    ]);

    // Create a survey linked to this assignment
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: TEAM_SURVEY_TITLE,
      description: "Complete this survey about your team.",
      status: "published",
      json: teamCollaborationSurveyJson,
      assignment_id: assignment.id,
      due_date: SURVEY_DUE_DATE.toISOString()
    });

    // Insert survey responses for all three students with varied numeric answers
    const responsesData = [
      {
        survey_id: survey.id,
        profile_id: studentA.private_profile_id,
        response: {
          q1: [1, 3],
          q2: [1, 3, 5],
          q3: 5,
          q4: 4,
          q5: 4,
          q6: 5,
          q7: 3,
          q16: 5,
          q21: 1,
          q23: 5,
          q24: 5,
          q9: [7],
          q15: "Our team collaboration has been excellent. We meet regularly and everyone contributes."
        },
        is_submitted: true,
        submitted_at: SUBMITTED_AT.toISOString()
      },
      {
        survey_id: survey.id,
        profile_id: studentB.private_profile_id,
        response: {
          q1: [1, 2],
          q2: [1, 2, 4],
          q3: 4,
          q4: 3,
          q5: 3,
          q6: 4,
          q7: 4,
          q16: 4,
          q21: 3,
          q23: 4,
          q24: 4,
          q9: [2, 3],
          q15: "Good progress but some scheduling issues. We need to plan our sprints better."
        },
        is_submitted: true,
        submitted_at: SUBMITTED_AT.toISOString()
      },
      {
        survey_id: survey.id,
        profile_id: studentC.private_profile_id,
        response: {
          q1: [4],
          q2: [2],
          q3: 3,
          q4: 2,
          q5: 2,
          q6: 3,
          q7: 5,
          q16: 3,
          q21: 4,
          q23: 3,
          q24: 3,
          q9: [1, 4, 5],
          q15: "I feel our team could communicate more. I was stuck waiting for others to finish their parts."
        },
        is_submitted: true,
        submitted_at: SUBMITTED_AT.toISOString()
      }
    ];

    const { error: bulkInsertErr } = await supabase.from("survey_responses").insert(responsesData);
    if (bulkInsertErr) throw new Error(`Failed to insert responses: ${bulkInsertErr.message}`);

    // Login as instructor and view responses
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    // Wait for the page to load
    await expect(page.getByRole("heading", { name: /Survey Responses/i })).toBeVisible();

    // Verify legacy summary stats are visible (exact match to avoid collision with analytics "Total Responses")
    await expect(page.getByText("TOTAL RESPONSES", { exact: true })).toBeVisible();
    await expect(page.getByText("RESPONSE RATE", { exact: true })).toBeVisible();
    await expect(page.getByText("TIME REMAINING", { exact: true })).toBeVisible();
    await expectTransparentText(page, /day|Closed|Less than|h|m/);

    // Verify new analytics UI: SurveyAnalytics block and numeric stat
    await expect(page.getByRole("heading", { name: "Survey Analytics" })).toBeVisible();
    await expect(page.getByText("Loading analytics...")).toBeHidden();
    await expect(page.getByText("Total Responses", { exact: true })).toBeVisible();

    // Verify group-specific section from group/mentor aggregation (GroupSummaryCards)
    await expect(page.getByText("Team Alpha").first()).toBeVisible();
    await expect(page.getByText("Team Beta").first()).toBeVisible();

    await visualScreenshot(page, "Instructor Survey Responses - Overview");

    // Check responses table shows at least some survey response content (text may be truncated)
    await expect(page.locator("body")).toContainText("Our team collaboration");
    await expect(page.locator("body")).toContainText("Good progress");

    await expectTransparentText(page, /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M E[DS]T/);
    await visualScreenshot(page, "Instructor Survey Responses - Individual Responses Table");
  });

  test("instructor views survey manage page with linked assignment column", async ({ page }) => {
    // Create an assignment to link
    const assignment = await insertAssignment({
      due_date: ASSIGNMENT_DUE_DATE.toISOString(),
      class_id: course.id,
      name: "Project Sprint 5",
      assignment_slug: `project-sprint-5-${course.id}`
    });

    // Create a survey linked to the assignment
    await seedSurvey(course, instructor, {
      title: TEAM_SURVEY_TITLE,
      description: "Weekly team survey",
      status: "published",
      json: teamCollaborationSurveyJson,
      assignment_id: assignment.id,
      due_date: SURVEY_DUE_DATE.toISOString()
    });

    // Create an unlinked survey
    await seedSurvey(course, instructor, {
      title: COURSE_FEEDBACK_SURVEY_TITLE,
      description: "End of semester feedback",
      status: "published",
      json: { pages: [{ name: "p1", elements: [{ type: "comment", name: "feedback", title: "General feedback" }] }] }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    // The manage page should show the linked assignment column
    await expect(page.getByText(TEAM_SURVEY_TITLE)).toBeVisible();
    await expect(page.getByText(COURSE_FEEDBACK_SURVEY_TITLE)).toBeVisible();

    // Verify linked-assignment column cells: linked survey shows assignment label, unlinked shows fallback
    const linkedRow = page.getByRole("row").filter({ hasText: TEAM_SURVEY_TITLE });
    await expect(linkedRow).toContainText("Project Sprint 5");

    const unlinkedRow = page.getByRole("row").filter({ hasText: COURSE_FEEDBACK_SURVEY_TITLE });
    await expect(unlinkedRow).toContainText("—");

    await visualScreenshot(page, "Instructor Manage Surveys - Linked Assignment Column");
  });

  test("student submitted survey shows read-only view", async ({ page }) => {
    // Create a published survey (editing NOT allowed)
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: TEAM_SURVEY_TITLE,
      description: "Please complete this weekly survey.",
      status: "published",
      json: teamCollaborationSurveyJson,
      allow_response_editing: false,
      due_date: SURVEY_DUE_DATE.toISOString()
    });

    // Insert a submitted response for studentA
    await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
      response: {
        q1: [1],
        q2: [1, 3],
        q3: 5,
        q4: 3,
        q5: 3,
        q6: 5,
        q7: 3,
        q16: 5,
        q21: 1,
        q23: 5,
        q24: 5,
        q9: [7],
        q15: "Great team collaboration this week!"
      },
      is_submitted: true,
      submitted_at: SUBMITTED_AT.toISOString()
    });

    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys/${survey.id}`);

    // Should show read-only indicator
    await expect(page.getByText("This survey has been submitted and cannot be edited.")).toBeVisible();
    await assertStudentPageAccessible(page, "submitted survey read-only (shell)");
    await visualScreenshot(page, "Student Survey - Submitted Read Only View");
  });
});
