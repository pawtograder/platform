import { test, expect } from "../global-setup";
import { argosScreenshot } from "@argos-ci/playwright";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase
} from "./TestingUtils";
import type { TablesInsert } from "../../utils/supabase/SupabaseTypes";
import { addDays } from "date-fns";

dotenv.config({ path: ".env.local" });

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];
type SurveyInsert = TablesInsert<"surveys">;

/**
 * Weekly team collaboration survey JSON matching the provided questionnaire.
 * Uses survey-js format with:
 *   - Q1/Q2: checkbox (multi-select)
 *   - Q3–Q7: radiogroup (Likert-type)
 *   - Q16,Q21,Q23,Q24: radiogroup (Likert-type)
 *   - Q9: checkbox
 *   - Q15: comment (long text)
 */
const teamCollaborationSurveyJson = {
  pages: [
    {
      name: "page1",
      elements: [
        {
          type: "checkbox",
          name: "q1",
          title: "This week I have...",
          choices: [
            { value: 1, text: "Completed all my assigned tasks" },
            { value: 4, text: "Completed some of my assigned tasks" },
            { value: 2, text: "Asked a teammate for help completing my task(s)" },
            { value: 3, text: "Helped a teammate complete a portion of their task(s)" },
            { value: 5, text: "Other" }
          ],
          hasOther: true
        },
        {
          type: "checkbox",
          name: "q2",
          title: "This week I have interacted with my team by...",
          choices: [
            { value: 1, text: "Met live (including Zoom meetings, Discord voicechat, or similar) with my team" },
            {
              value: 2,
              text: "Participated in checkins with my team (via text, email, GroupMe, or similar)"
            },
            { value: 3, text: "Opened a Pull Request and asked my team for feedback on my code" },
            {
              value: 4,
              text: "Asked my team for feedback on my non-code work (requirements, design, test plan)"
            },
            {
              value: 5,
              text: "Reviewed technical artifacts (design, requirements, tests, or code) for my teammates"
            },
            { value: 6, text: "Other" }
          ],
          hasOther: true
        }
      ]
    },
    {
      name: "page2",
      elements: [
        {
          type: "radiogroup",
          name: "q3",
          title: "This week, I knew what I needed to get done",
          choices: [
            { value: 1, text: "Strongly agree" },
            { value: 2, text: "Agree" },
            { value: 4, text: "Neither agree nor disagree" },
            { value: 6, text: "Disagree" },
            { value: 7, text: "Strongly disagree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q4",
          title: "This week, I have gotten done ___________ than I think I should have",
          choices: [
            { value: 1, text: "Much more" },
            { value: 2, text: "A bit more" },
            { value: 3, text: "About as much as" },
            { value: 4, text: "A bit less" },
            { value: 5, text: "Much less" }
          ]
        },
        {
          type: "radiogroup",
          name: "q5",
          title: "This week, my team overall has gotten done ___________ than I think we should have",
          choices: [
            { value: 1, text: "Much more" },
            { value: 2, text: "A bit more" },
            { value: 3, text: "About as much as" },
            { value: 4, text: "A bit less" },
            { value: 5, text: "Much less" }
          ]
        },
        {
          type: "radiogroup",
          name: "q6",
          title: "Overall, I think that everyone has been contributing adequately to the success of the project",
          choices: [
            { value: 1, text: "Strongly agree" },
            { value: 5, text: "Agree" },
            { value: 6, text: "Neither agree nor disagree" },
            { value: 7, text: "Disagree" },
            { value: 8, text: "Strongly disagree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q7",
          title: "Next week, I intend to get done ______ than I did this week",
          choices: [
            { value: 1, text: "Much more" },
            { value: 2, text: "A bit more" },
            { value: 3, text: "About as much as" },
            { value: 4, text: "A bit less" },
            { value: 5, text: "Much less" }
          ]
        }
      ]
    },
    {
      name: "page3",
      elements: [
        {
          type: "radiogroup",
          name: "q16",
          title: "In our team we relied on each other to get the job done.",
          choices: [
            { value: 5, text: "Strongly agree" },
            { value: 4, text: "Agree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 2, text: "Disagree" },
            { value: 1, text: "Strongly disagree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q21",
          title: "Team members keep information to themselves that should be shared with others.",
          choices: [
            { value: 5, text: "Strongly agree" },
            { value: 4, text: "Agree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 2, text: "Disagree" },
            { value: 1, text: "Strongly disagree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q23",
          title: "I am satisfied with the performance of my team.",
          choices: [
            { value: 5, text: "Strongly agree" },
            { value: 4, text: "Agree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 2, text: "Disagree" },
            { value: 1, text: "Strongly disagree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q24",
          title: "We have completed the tasks this week in a way we all agreed upon.",
          choices: [
            { value: 5, text: "Strongly agree" },
            { value: 4, text: "Agree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 2, text: "Disagree" },
            { value: 1, text: "Strongly disagree" }
          ]
        }
      ]
    },
    {
      name: "page4",
      elements: [
        {
          type: "checkbox",
          name: "q9",
          title: "My progress this week has been impeded by:",
          choices: [
            { value: 1, text: "Difficulties with technologies or course materials" },
            { value: 2, text: "Demands of other classes" },
            { value: 3, text: "Other personal responsibilities/distractions" },
            { value: 4, text: "Teammates who didn't complete their responsibilities" },
            { value: 5, text: "Communication difficulties with my teammates" },
            {
              value: 6,
              text: "Difficulties scheduling tasks so that I wasn't waiting for my team to complete their work"
            },
            { value: 7, text: "Other" },
            { value: 8, text: "None of the above: I was able to work productively" }
          ],
          hasOther: true
        },
        {
          type: "comment",
          name: "q15",
          title:
            "How do you feel about your team's collaboration process in this project? Please reflect in about two sentences."
        }
      ]
    }
  ]
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
      { role: "student", class_id: course.id, name: "Alice Student", useMagicLink: true },
      { role: "student", class_id: course.id, name: "Bob Student", useMagicLink: true },
      { role: "student", class_id: course.id, name: "Carol Student", useMagicLink: true },
      { role: "instructor", class_id: course.id, name: "Survey Instructor", useMagicLink: true },
      { role: "grader", class_id: course.id, name: "Survey Grader", useMagicLink: true }
    ]);
    [studentA, studentB, studentC, instructor, grader] = users;
    await clearCourseSurveys();
  });

  test("student views team collaboration survey and takes it", async ({ page }) => {
    // Create a published survey with the team collaboration JSON
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Week 5 Team Collaboration Survey",
      description: "Please complete this weekly survey about your team collaboration experience.",
      status: "published",
      json: teamCollaborationSurveyJson,
      due_date: addDays(new Date(), 3).toISOString()
    });

    await loginAsUser(page, studentA, course);

    // Navigate to the survey list
    await page.goto(`/course/${course.id}/surveys`);
    await expect(page.getByText("Week 5 Team Collaboration Survey")).toBeVisible();
    await argosScreenshot(page, "Student Survey List - Team Collaboration Survey Available");

    // Click to start the survey
    const startLink = page.getByRole("link", { name: /Start Survey/i });
    await expect(startLink).toBeVisible();
    await startLink.click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/surveys/${survey.id}`));

    // Page 1: Checkboxes
    // SurveyJS renders question titles in multiple places (span + hidden legend), so use .first()
    await expect(page.getByText("This week I have...").first()).toBeVisible();
    await argosScreenshot(page, "Student Survey - Page 1 Checkboxes");

    // Fill page 1 - click on the label text for SurveyJS checkboxes
    await page.locator("label").filter({ hasText: "Completed all my assigned tasks" }).click();
    await page.locator("label").filter({ hasText: "Helped a teammate complete a portion of their task(s)" }).click();

    await page
      .locator("label")
      .filter({ hasText: "Met live (including Zoom meetings, Discord voicechat, or similar) with my team" })
      .click();
    await page
      .locator("label")
      .filter({ hasText: "Opened a Pull Request and asked my team for feedback on my code" })
      .click();

    await argosScreenshot(page, "Student Survey - Page 1 Filled");

    // Navigate to page 2
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText("This week, I knew what I needed to get done").first()).toBeVisible();
    await argosScreenshot(page, "Student Survey - Page 2 Likert Questions");

    // Fill page 2 - click on the label text for SurveyJS radio buttons
    await page
      .locator("label")
      .filter({ hasText: /^Strongly agree$/ })
      .first()
      .click();
    await argosScreenshot(page, "Student Survey - Page 2 Partially Filled");

    // Navigate to page 3
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText("In our team we relied on each other to get the job done.").first()).toBeVisible();
    await argosScreenshot(page, "Student Survey - Page 3 Team Dynamics");

    // Navigate to page 4
    await page.getByRole("button", { name: /Next/i }).click();
    await expect(page.getByText("My progress this week has been impeded by:").first()).toBeVisible();
    await expect(
      page.getByText("How do you feel about your team's collaboration process in this project?").first()
    ).toBeVisible();
    await argosScreenshot(page, "Student Survey - Page 4 Impediments and Reflection");
  });

  test("student sees survey status banner on submission page", async ({ page }) => {
    // Create an assignment
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toISOString(),
      class_id: course.id
    });

    // Create a submission for studentA
    await insertPreBakedSubmission({
      student_profile_id: studentA.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    // Create a survey linked to this assignment
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Week 5 Team Collaboration Survey",
      description: "Complete this survey about your team.",
      status: "published",
      json: teamCollaborationSurveyJson,
      assignment_id: assignment.id,
      due_date: addDays(new Date(), 5).toISOString()
    });

    await loginAsUser(page, studentA, course);

    // Navigate to the submission page
    await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions`);

    // Wait for the survey status banner to appear
    await expect(page.getByText("Survey: Week 5 Team Collaboration Survey")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Pending")).toBeVisible();
    await expect(page.getByText("Take Survey")).toBeVisible();

    await argosScreenshot(page, "Student Submission Page - Survey Pending Banner");

    // Now submit a response for this student to see the completed state
    const { error: respError } = await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
      response: {
        q1: [1, 3],
        q2: [1, 3],
        q3: 1,
        q4: 3,
        q5: 3,
        q6: 1,
        q7: 3,
        q16: 5,
        q21: 1,
        q23: 5,
        q24: 4,
        q9: [8],
        q15: "Our team collaborates well through regular meetings and code reviews."
      },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });
    if (respError) throw new Error(`Failed to insert response: ${respError.message}`);

    // Reload to see the completed status
    await page.reload();
    await expect(page.getByText("Survey: Week 5 Team Collaboration Survey")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Completed")).toBeVisible();
    await expect(page.getByText("View Response")).toBeVisible();

    await argosScreenshot(page, "Student Submission Page - Survey Completed Banner");
  });

  test("instructor views survey responses and analytics", async ({ page }) => {
    // Create an assignment
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toISOString(),
      class_id: course.id
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
      title: "Week 5 Team Collaboration Survey",
      description: "Complete this survey about your team.",
      status: "published",
      json: teamCollaborationSurveyJson,
      assignment_id: assignment.id,
      due_date: addDays(new Date(), 5).toISOString()
    });

    // Insert survey responses for all three students with varied numeric answers
    const responsesData = [
      {
        survey_id: survey.id,
        profile_id: studentA.private_profile_id,
        response: {
          q1: [1, 3],
          q2: [1, 3, 5],
          q3: 1,
          q4: 2,
          q5: 2,
          q6: 1,
          q7: 3,
          q16: 5,
          q21: 1,
          q23: 5,
          q24: 5,
          q9: [8],
          q15: "Our team collaboration has been excellent. We meet regularly and everyone contributes."
        },
        is_submitted: true,
        submitted_at: new Date().toISOString()
      },
      {
        survey_id: survey.id,
        profile_id: studentB.private_profile_id,
        response: {
          q1: [1, 2],
          q2: [1, 2, 4],
          q3: 2,
          q4: 3,
          q5: 3,
          q6: 5,
          q7: 2,
          q16: 4,
          q21: 3,
          q23: 4,
          q24: 4,
          q9: [2, 3],
          q15: "Good progress but some scheduling issues. We need to plan our sprints better."
        },
        is_submitted: true,
        submitted_at: new Date().toISOString()
      },
      {
        survey_id: survey.id,
        profile_id: studentC.private_profile_id,
        response: {
          q1: [4],
          q2: [2],
          q3: 4,
          q4: 4,
          q5: 4,
          q6: 6,
          q7: 1,
          q16: 3,
          q21: 4,
          q23: 3,
          q24: 3,
          q9: [1, 4, 5],
          q15: "I feel our team could communicate more. I was stuck waiting for others to finish their parts."
        },
        is_submitted: true,
        submitted_at: new Date().toISOString()
      }
    ];

    const { error: bulkInsertErr } = await supabase.from("survey_responses").insert(responsesData);
    if (bulkInsertErr) throw new Error(`Failed to insert responses: ${bulkInsertErr.message}`);

    // Login as instructor and view responses
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys/${survey.survey_id}/responses`);

    // Wait for the page to load
    await expect(page.getByRole("heading", { name: /Survey Responses/i })).toBeVisible();
    await argosScreenshot(page, "Instructor Survey Responses - Overview");

    // Verify summary stats are visible
    await expect(page.getByText("TOTAL RESPONSES")).toBeVisible();
    await expect(page.getByText("RESPONSE RATE")).toBeVisible();
    await expect(page.getByText("TIME REMAINING")).toBeVisible();

    // Check responses table is visible with student responses
    await expect(page.getByText("Our team collaboration has been excellent")).toBeVisible();
    await expect(page.getByText("Good progress but some scheduling issues")).toBeVisible();

    await argosScreenshot(page, "Instructor Survey Responses - Individual Responses Table");
  });

  test("instructor views survey manage page with linked assignment column", async ({ page }) => {
    // Create an assignment to link
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toISOString(),
      class_id: course.id,
      name: "Project Sprint 5"
    });

    // Create a survey linked to the assignment
    await seedSurvey(course, instructor, {
      title: "Week 5 Team Collaboration Survey",
      description: "Weekly team survey",
      status: "published",
      json: teamCollaborationSurveyJson,
      assignment_id: assignment.id,
      due_date: addDays(new Date(), 5).toISOString()
    });

    // Create an unlinked survey
    await seedSurvey(course, instructor, {
      title: "General Course Feedback",
      description: "End of semester feedback",
      status: "published",
      json: { pages: [{ name: "p1", elements: [{ type: "comment", name: "feedback", title: "General feedback" }] }] }
    });

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/surveys`);

    // The manage page should show the linked assignment column
    await expect(page.getByText("Week 5 Team Collaboration Survey")).toBeVisible();
    await expect(page.getByText("General Course Feedback")).toBeVisible();

    // Verify linked-assignment column cells: linked survey shows assignment label, unlinked shows fallback
    const linkedRow = page.getByRole("row").filter({ hasText: "Week 5 Team Collaboration Survey" });
    await expect(linkedRow).toContainText("Project Sprint 5");

    const unlinkedRow = page.getByRole("row").filter({ hasText: "General Course Feedback" });
    await expect(unlinkedRow).toContainText("—");

    await argosScreenshot(page, "Instructor Manage Surveys - Linked Assignment Column");
  });

  test("student submitted survey shows read-only view", async ({ page }) => {
    // Create a published survey (editing NOT allowed)
    const survey = await seedSurvey<{ id: string; survey_id: string }>(course, instructor, {
      title: "Week 5 Team Collaboration Survey",
      description: "Please complete this weekly survey.",
      status: "published",
      json: teamCollaborationSurveyJson,
      allow_response_editing: false,
      due_date: addDays(new Date(), 3).toISOString()
    });

    // Insert a submitted response for studentA
    await supabase.from("survey_responses").insert({
      survey_id: survey.id,
      profile_id: studentA.private_profile_id,
      response: {
        q1: [1],
        q2: [1, 3],
        q3: 1,
        q4: 3,
        q5: 3,
        q6: 1,
        q7: 3,
        q16: 5,
        q21: 1,
        q23: 5,
        q24: 5,
        q9: [8],
        q15: "Great team collaboration this week!"
      },
      is_submitted: true,
      submitted_at: new Date().toISOString()
    });

    await loginAsUser(page, studentA, course);
    await page.goto(`/course/${course.id}/surveys/${survey.id}`);

    // Should show read-only indicator
    await expect(page.getByText("This survey has been submitted and cannot be edited.")).toBeVisible();
    await argosScreenshot(page, "Student Survey - Submitted Read Only View");
  });
});
