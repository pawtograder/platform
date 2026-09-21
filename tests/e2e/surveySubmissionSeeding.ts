/**
 * Seeding for the "survey responses on a submission" feature.
 *
 * One call builds the whole shape the feature needs: a group assignment, surveys linked to it
 * through `surveys.assignment_id`, a group submission, a solo submission, and responses for SOME
 * but not all group members. The partial-response part is the point. A member with no response row
 * is what `get_survey_responses_for_submission` exists to surface, and a member whose only row is
 * soft-deleted must look the same as one who never started.
 *
 * Consumed by `survey-responses-for-submission-db.spec.ts` (the RPC and its authorization matrix)
 * and `submission-survey-tab.spec.ts` (the grader and student views).
 *
 * Additive: nothing in `scripts/SeedDB.ts`, `scripts/DatabaseSeedingUtils.ts` or any existing spec
 * imports this module.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "date-fns";
import type { Database, TablesInsert } from "@/utils/supabase/SupabaseTypes";
import { createClass, createUsersInClass, insertAssignment, insertPreBakedSubmission, supabase } from "./TestingUtils";
import type { TestingUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

/**
 * A deliberately small SurveyJS model. The browser spec renders this, and two questions are enough
 * to tell a rendered response apart from a "not started" card. `tests/fixtures/teamCollaborationSurvey.ts`
 * is the realistic 24-question model, and paging through it buys these specs nothing.
 */
export const SUBMISSION_SURVEY_JSON = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "comment", name: "teamwork", title: "How did your team work together this week?" },
        { type: "rating", name: "load", title: "How balanced was the workload?", rateMin: 1, rateMax: 5 }
      ]
    }
  ]
};

/** Survey titles are ordered so the RPC's `ORDER BY survey_title` is predictable in assertions. */
export const SURVEY_TITLES = {
  published: "A Published Team Survey",
  closed: "B Closed Team Survey",
  draft: "C Draft Team Survey",
  future: "D Not Yet Open Survey"
} as const;

/** Distinctive free-text answers, so a spec can assert one member's text is absent from a DOM. */
export const SURVEY_ANSWER_TEXT = {
  submitter: "Sam wrote the parser and reviewed two pull requests.",
  teammate: "Tina paired with Sam on the parser tests.",
  softDeleted: "Dana retracted this answer before the deadline."
} as const;

export type SurveySubmissionFixture = {
  course: Course;
  instructor: TestingUser;
  grader: TestingUser;
  /** Group member named on `submissions.profile_id`. Has a submitted response. */
  submitter: TestingUser;
  /** Group member with a submitted response, but not the submitter. */
  teammate: TestingUser;
  /** Group member with NO `survey_responses` row at all. */
  notStarted: TestingUser;
  /** Group member whose only response row has `deleted_at` set. */
  softDeleted: TestingUser;
  /**
   * Owns the solo submission. For the group submission this student is an enrolled outsider: not a
   * member of the group and not its submitter.
   */
  soloStudent: TestingUser;
  /** Instructor in a different class entirely. */
  otherClassInstructor: TestingUser;
  otherCourse: Course;
  assignmentId: number;
  /** An assignment in the same class with no survey linked to it. */
  surveylessAssignmentId: number;
  groupId: number;
  groupSubmissionId: number;
  soloSubmissionId: number;
  /** A submission on the survey-less assignment, owned by `soloStudent`. */
  surveylessSubmissionId: number;
  publishedSurveyId: string;
  closedSurveyId: string;
  draftSurveyId: string;
  /** Published, but `available_at` is in the future. The RPC returns it anyway. */
  futureSurveyId: string;
};

async function seedSurvey({
  course,
  instructor,
  assignmentId,
  title,
  status,
  availableAt,
  allowResponseEditing = false
}: {
  course: Course;
  instructor: TestingUser;
  /** Null for a survey that is not linked to any assignment. */
  assignmentId: number | null;
  title: string;
  status: "draft" | "published" | "closed";
  availableAt?: string | null;
  allowResponseEditing?: boolean;
}): Promise<string> {
  const { data, error } = await supabase
    .from("surveys")
    .insert({
      class_id: course.id,
      created_by: instructor.public_profile_id,
      assignment_id: assignmentId,
      assigned_to_all: true,
      allow_response_editing: allowResponseEditing,
      json: SUBMISSION_SURVEY_JSON,
      version: 1,
      status,
      title,
      description: `${title} description`,
      due_date: addDays(new Date(), 7).toISOString(),
      available_at: availableAt ?? null
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to seed survey "${title}": ${error?.message}`);
  return data.id;
}

/**
 * Seed a class, a group assignment with four surveys linked to it, a four-member group with a
 * submission, and a solo submission by a fifth student.
 *
 * Response coverage across the group, for the published and closed surveys:
 * submitter and teammate answered, `softDeleted` answered and the row was then soft-deleted, and
 * `notStarted` has no row.
 */
export async function seedSurveySubmissionFixture(): Promise<SurveySubmissionFixture> {
  const course = await createClass({ name: "E2E Survey On Submission" });
  const otherCourse = await createClass({ name: "E2E Survey On Submission Outsider" });

  const [submitter, teammate, notStarted, softDeleted, soloStudent, instructor, grader] = await createUsersInClass([
    {
      role: "student",
      class_id: course.id,
      name: "Sam Submitter",
      email: `survey-sub-submitter-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "student",
      class_id: course.id,
      name: "Tina Teammate",
      email: `survey-sub-teammate-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "student",
      class_id: course.id,
      name: "Nina Notstarted",
      email: `survey-sub-notstarted-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "student",
      class_id: course.id,
      name: "Dana Deleted",
      email: `survey-sub-deleted-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "student",
      class_id: course.id,
      name: "Sol Solo",
      email: `survey-sub-solo-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "instructor",
      class_id: course.id,
      name: "Ingrid Instructor",
      email: `survey-sub-instructor-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "grader",
      class_id: course.id,
      name: "Gary Grader",
      email: `survey-sub-grader-${course.id}@pawtograder.net`,
      useMagicLink: true
    }
  ]);

  const [otherClassInstructor] = await createUsersInClass([
    {
      role: "instructor",
      class_id: otherCourse.id,
      name: "Otto Otherclass Instructor",
      email: `survey-sub-other-instructor-${otherCourse.id}@pawtograder.net`,
      useMagicLink: true
    }
  ]);

  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 10).toISOString(),
    class_id: course.id,
    name: "Survey On Submission Group Assignment",
    assignment_slug: `survey-on-submission-group-${course.id}`,
    group_config: "both",
    min_group_size: 1,
    max_group_size: 6
  });

  const surveylessAssignment = await insertAssignment({
    due_date: addDays(new Date(), 10).toISOString(),
    class_id: course.id,
    name: "No Survey Assignment",
    assignment_slug: `survey-on-submission-none-${course.id}`
  });

  const { data: group, error: groupError } = await supabase
    .from("assignment_groups")
    .insert({
      assignment_id: assignment.id,
      class_id: course.id,
      name: "Team Parser"
    })
    .select("id")
    .single();
  if (groupError || !group) throw new Error(`Failed to create assignment group: ${groupError?.message}`);

  const groupMembers = [submitter, teammate, notStarted, softDeleted];
  const { error: memberError } = await supabase.from("assignment_groups_members").insert(
    groupMembers.map((member) => ({
      assignment_group_id: group.id,
      profile_id: member.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id,
      added_by: instructor.private_profile_id
    }))
  );
  if (memberError) throw new Error(`Failed to add group members: ${memberError.message}`);

  // Both `assignment_group_id` and `profile_id` are set so `is_submitter` has something to match.
  // See the note in survey-responses-for-submission-db.spec.ts about what the production ingest
  // path writes instead.
  const groupSubmission = await insertPreBakedSubmission({
    student_profile_id: submitter.private_profile_id,
    assignment_group_id: group.id,
    assignment_id: assignment.id,
    class_id: course.id
  });

  const soloSubmission = await insertPreBakedSubmission({
    student_profile_id: soloStudent.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });

  const surveylessSubmission = await insertPreBakedSubmission({
    student_profile_id: soloStudent.private_profile_id,
    assignment_id: surveylessAssignment.id,
    class_id: course.id
  });

  const publishedSurveyId = await seedSurvey({
    course,
    instructor,
    assignmentId: assignment.id,
    title: SURVEY_TITLES.published,
    status: "published"
  });
  const closedSurveyId = await seedSurvey({
    course,
    instructor,
    assignmentId: assignment.id,
    title: SURVEY_TITLES.closed,
    status: "closed"
  });
  const draftSurveyId = await seedSurvey({
    course,
    instructor,
    assignmentId: assignment.id,
    title: SURVEY_TITLES.draft,
    status: "draft"
  });
  const futureSurveyId = await seedSurvey({
    course,
    instructor,
    assignmentId: assignment.id,
    title: SURVEY_TITLES.future,
    status: "published",
    availableAt: addDays(new Date(), 30).toISOString()
  });

  const submittedAt = new Date().toISOString();
  const respondingSurveys = [publishedSurveyId, closedSurveyId, futureSurveyId];
  const responseRows: TablesInsert<"survey_responses">[] = respondingSurveys.flatMap((survey_id) => [
    {
      survey_id,
      profile_id: submitter.private_profile_id,
      response: { teamwork: SURVEY_ANSWER_TEXT.submitter, load: 4 },
      is_submitted: true,
      submitted_at: submittedAt
    },
    {
      survey_id,
      profile_id: teammate.private_profile_id,
      response: { teamwork: SURVEY_ANSWER_TEXT.teammate, load: 3 },
      is_submitted: true,
      submitted_at: submittedAt
    },
    {
      survey_id,
      profile_id: softDeleted.private_profile_id,
      response: { teamwork: SURVEY_ANSWER_TEXT.softDeleted, load: 2 },
      is_submitted: true,
      submitted_at: submittedAt
    }
  ]);

  // The solo submitter answers the published survey so the solo case has content to show.
  responseRows.push({
    survey_id: publishedSurveyId,
    profile_id: soloStudent.private_profile_id,
    response: { teamwork: "Sol worked alone on the whole assignment.", load: 5 },
    is_submitted: true,
    submitted_at: submittedAt
  });

  const { error: responseError } = await supabase.from("survey_responses").insert(responseRows);
  if (responseError) throw new Error(`Failed to seed survey responses: ${responseError.message}`);

  // Retract Dana's answers after the fact, which is what the product's delete path does.
  const { error: softDeleteError } = await supabase
    .from("survey_responses")
    .update({ deleted_at: new Date().toISOString() })
    .eq("profile_id", softDeleted.private_profile_id)
    .in("survey_id", respondingSurveys);
  if (softDeleteError) throw new Error(`Failed to soft-delete a survey response: ${softDeleteError.message}`);

  return {
    course,
    otherCourse,
    instructor,
    grader,
    submitter,
    teammate,
    notStarted,
    softDeleted,
    soloStudent,
    otherClassInstructor,
    assignmentId: assignment.id,
    surveylessAssignmentId: surveylessAssignment.id,
    groupId: group.id,
    groupSubmissionId: groupSubmission.submission_id,
    soloSubmissionId: soloSubmission.submission_id,
    surveylessSubmissionId: surveylessSubmission.submission_id,
    publishedSurveyId,
    closedSurveyId,
    draftSurveyId,
    futureSurveyId
  };
}

export type SurveyResponseForSubmissionRow = {
  survey_id: string;
  survey_title: string;
  survey_json: Record<string, unknown> | null;
  survey_status: "draft" | "published" | "closed";
  due_date: string | null;
  available_at: string | null;
  profile_id: string;
  profile_name: string | null;
  is_submitter: boolean;
  is_submitted: boolean;
  submitted_at: string | null;
  updated_at: string | null;
  response: Record<string, unknown> | null;
};

type RpcResult = {
  data: SurveyResponseForSubmissionRow[] | null;
  error: { message: string; code?: string } | null;
};

/**
 * Call `get_survey_responses_for_submission`.
 *
 * The cast is deliberate: the RPC is newer than `utils/supabase/SupabaseTypes.d.ts`, which is
 * regenerated by `npm run client-local` once the migration has been applied, so the typed client
 * does not know the function name yet. Keeping the cast in one place means these specs compile
 * whether or not the types have been regenerated.
 */
export async function getSurveyResponsesForSubmission(
  client: SupabaseClient<Database>,
  submissionId: number
): Promise<RpcResult> {
  const untyped = client as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  };
  return untyped.rpc("get_survey_responses_for_submission", { p_submission_id: submissionId });
}

/**
 * Distinct answer text for the editable-survey fixture, so an assertion about what was stored
 * cannot accidentally match text seeded by `seedSurveySubmissionFixture`.
 */
export const EDITABLE_ANSWER_TEXT = {
  submittedOriginal: "Editable submitted answer as first written.",
  submittedRevised: "Editable submitted answer after a legitimate re-submit.",
  downgradeAttempt: "Editable answer smuggled in alongside an un-submit.",
  draftOriginal: "Editable draft answer, not submitted yet.",
  draftSubmitted: "Editable draft answer at the moment it was submitted.",
  corrections: "Editable submitted answer used for column-only updates."
} as const;

export type EditableSurveyFixture = {
  course: Course;
  instructor: TestingUser;
  /** Owns a submitted response. The un-submit attempts run as this student. */
  submittedStudent: TestingUser;
  /** Owns a draft response, for the ordinary false to true submit. */
  draftStudent: TestingUser;
  /** Owns a second submitted response, used for updates that leave `is_submitted` alone. */
  correctionsStudent: TestingUser;
  surveyId: string;
};

/**
 * Seed a published survey with `allow_response_editing = true` and three responses on it.
 *
 * The editing flag is what makes this fixture useful. `survey_responses_update_owner` lets a
 * student UPDATE an already-submitted row only on a survey that opted into re-editing, so on a
 * non-editable survey RLS rejects the write before any trigger runs, and a test built on one
 * would pass on the policy while proving nothing about the trigger.
 *
 * No `assignment_id`: this survey has nothing to do with a submission, and leaving it unlinked
 * keeps it out of `get_survey_responses_for_submission` and therefore out of the RPC spec's
 * assertions.
 */
export async function seedEditableSurveyFixture(): Promise<EditableSurveyFixture> {
  const course = await createClass({ name: "E2E Survey No Unsubmit" });

  const [submittedStudent, draftStudent, correctionsStudent, instructor] = await createUsersInClass([
    {
      role: "student",
      class_id: course.id,
      name: "Uma Unsubmit",
      email: `survey-unsubmit-submitted-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "student",
      class_id: course.id,
      name: "Drew Draft",
      email: `survey-unsubmit-draft-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "student",
      class_id: course.id,
      name: "Cora Correction",
      email: `survey-unsubmit-corrections-${course.id}@pawtograder.net`,
      useMagicLink: true
    },
    {
      role: "instructor",
      class_id: course.id,
      name: "Ivan Instructor",
      email: `survey-unsubmit-instructor-${course.id}@pawtograder.net`,
      useMagicLink: true
    }
  ]);

  const surveyId = await seedSurvey({
    course,
    instructor,
    assignmentId: null,
    title: "Editable Weekly Survey",
    status: "published",
    allowResponseEditing: true
  });

  const submittedAt = new Date().toISOString();
  const rows: TablesInsert<"survey_responses">[] = [
    {
      survey_id: surveyId,
      profile_id: submittedStudent.private_profile_id,
      response: { teamwork: EDITABLE_ANSWER_TEXT.submittedOriginal, load: 4 },
      is_submitted: true,
      submitted_at: submittedAt
    },
    {
      survey_id: surveyId,
      profile_id: draftStudent.private_profile_id,
      response: { teamwork: EDITABLE_ANSWER_TEXT.draftOriginal, load: 2 },
      is_submitted: false
    },
    {
      survey_id: surveyId,
      profile_id: correctionsStudent.private_profile_id,
      response: { teamwork: EDITABLE_ANSWER_TEXT.corrections, load: 3 },
      is_submitted: true,
      submitted_at: submittedAt
    }
  ];
  const { error } = await supabase.from("survey_responses").insert(rows);
  if (error) throw new Error(`Failed to seed editable survey responses: ${error.message}`);

  return { course, instructor, submittedStudent, draftStudent, correctionsStudent, surveyId };
}

/**
 * Read a response row with the service-role client, bypassing RLS, so an assertion sees what
 * actually landed in the table rather than what the writing student is allowed to see.
 */
export async function readStoredResponse(surveyId: string, profileId: string) {
  const { data, error } = await supabase
    .from("survey_responses")
    .select("id, is_submitted, submitted_at, deleted_at, response, updated_at")
    .eq("survey_id", surveyId)
    .eq("profile_id", profileId)
    .single();
  if (error || !data) throw new Error(`Failed to read stored survey response: ${error?.message}`);
  return data;
}
