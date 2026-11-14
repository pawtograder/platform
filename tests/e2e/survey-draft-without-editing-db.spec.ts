/**
 * DB-level coverage for issue #977: on a survey with `allow_response_editing = false` (the
 * default), a student's in-progress answers are saved as a draft, and only the submission is
 * final.
 *
 * The survey page used to skip autosave entirely on these surveys, so nothing reached the table
 * until Complete. The fix is client-only because RLS already permits it:
 * `survey_responses_update_owner` (20260817120000) blocks an update only when the row is already
 * submitted and the survey does not allow editing. This spec pins that, so the client change
 * cannot be undone by a later tightening of the policy without a test failing.
 *
 * Every write goes through an authenticated STUDENT client: the service role bypasses RLS and
 * would make the assertions meaningless. Reads use `readStoredResponse` (service role) to see
 * what actually landed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createAuthenticatedClient, createClass, createUsersInClass, supabase, type TestingUser } from "./TestingUtils";
import { readStoredResponse } from "./surveySubmissionSeeding";

test.describe("survey drafts on a survey without response editing", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let student: TestingUser;
  let studentClient: SupabaseClient<Database>;
  let surveyId: string;

  test.beforeAll(async () => {
    const course = await createClass({ name: "E2E Survey Draft Without Editing" });
    const [s, instructor] = await createUsersInClass([
      {
        role: "student",
        class_id: course.id,
        name: "Dana Draft",
        email: `survey-draft-noedit-student-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "instructor",
        class_id: course.id,
        name: "Nico Noedit",
        email: `survey-draft-noedit-instructor-${course.id}@pawtograder.net`,
        useMagicLink: true
      }
    ]);
    student = s;

    const { data, error } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        assigned_to_all: true,
        allow_response_editing: false,
        json: { pages: [{ name: "page1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }] },
        version: 1,
        status: "published",
        title: "Survey Without Editing",
        description: "Drafts save; the submission is final."
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to seed survey: ${error?.message}`);
    surveyId = data.id;

    studentClient = await createAuthenticatedClient(student);
  });

  /** Upsert the student's own row the way the survey page does. */
  async function upsertOwnResponse(response: { q1: string }, isSubmitted: boolean) {
    return studentClient
      .from("survey_responses")
      .upsert(
        {
          survey_id: surveyId,
          profile_id: student.private_profile_id,
          response,
          is_submitted: isSubmitted,
          ...(isSubmitted ? { submitted_at: new Date().toISOString() } : {})
        },
        { onConflict: "survey_id,profile_id" }
      )
      .select("id, is_submitted");
  }

  test("a student can save a draft and then change it", async () => {
    const first = await upsertOwnResponse({ q1: "first draft" }, false);
    expect(first.error).toBeNull();
    expect(first.data).toHaveLength(1);

    const second = await upsertOwnResponse({ q1: "second draft" }, false);
    expect(second.error).toBeNull();
    expect(second.data).toHaveLength(1);

    const stored = await readStoredResponse(surveyId, student.private_profile_id);
    expect(stored.is_submitted).toBe(false);
    expect(stored.response).toEqual({ q1: "second draft" });
  });

  test("submitting the draft works, and the submission is then final", async () => {
    const submit = await upsertOwnResponse({ q1: "submitted answer" }, true);
    expect(submit.error).toBeNull();
    expect(submit.data).toHaveLength(1);

    // RLS matches zero rows on a submitted response to a non-editable survey: the write is
    // either refused outright (the upsert's conflict path) or changes nothing.
    await upsertOwnResponse({ q1: "edit after submitting" }, true);
    const update = await studentClient
      .from("survey_responses")
      .update({ response: { q1: "edit after submitting" } })
      .eq("survey_id", surveyId)
      .eq("profile_id", student.private_profile_id)
      .select("id");
    expect(update.data ?? []).toHaveLength(0);

    const stored = await readStoredResponse(surveyId, student.private_profile_id);
    expect(stored.is_submitted).toBe(true);
    expect(stored.response).toEqual({ q1: "submitted answer" });
  });
});
