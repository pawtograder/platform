/**
 * DB-level coverage for the `survey_response_no_unsubmit` trigger
 * (20260921000100_survey_response_no_unsubmit.sql): a submitted survey response may not be
 * returned to draft.
 *
 * Two ways this suite could pass while testing nothing, both deliberately closed:
 *
 * 1. Acting as the service role. `service_role` is exempt from the trigger by design, so an
 *    attempted downgrade through the admin client succeeds and an assertion on it would be
 *    meaningless. Every write below goes through an authenticated STUDENT client. The exemption
 *    itself is not asserted anywhere: a test that pinned "the admin client CAN downgrade" would
 *    enshrine a corruption path as expected behavior.
 *
 * 2. Acting on a survey with `allow_response_editing = false`. `survey_responses_update_owner`
 *    has `USING (... AND (NOT is_submitted OR survey_allows_response_editing(survey_id)))`, so on
 *    a non-editable survey RLS matches zero rows and PostgREST answers 200 with an empty body.
 *    There is no error to assert on, and the trigger never runs. The fixture therefore seeds an
 *    editable survey, which is also the configuration the re-submit and autosave paths use.
 *
 * The legitimate transitions are asserted alongside the rejection. A trigger that over-fires
 * would break re-submit and ordinary submit, and only those assertions would catch it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createAuthenticatedClient, type TestingUser } from "./TestingUtils";
import {
  EDITABLE_ANSWER_TEXT,
  readStoredResponse,
  seedEditableSurveyFixture,
  type EditableSurveyFixture
} from "./surveySubmissionSeeding";

test.describe("survey_responses may not be un-submitted", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let fx: EditableSurveyFixture;
  const clients = new Map<string, SupabaseClient<Database>>();

  /** Authenticated clients cost a magic-link round trip, so mint one per student and reuse it. */
  async function clientFor(user: TestingUser): Promise<SupabaseClient<Database>> {
    const cached = clients.get(user.email);
    if (cached) return cached;
    const created = await createAuthenticatedClient(user);
    clients.set(user.email, created);
    return created;
  }

  /** PATCH the student's own row as that student, the way the survey page does. */
  async function patchOwnResponse(user: TestingUser, patch: Record<string, unknown>) {
    const client = await clientFor(user);
    return client
      .from("survey_responses")
      .update(patch as never)
      .eq("survey_id", fx.surveyId)
      .eq("profile_id", user.private_profile_id)
      .select("id, is_submitted");
  }

  test.beforeAll(async () => {
    fx = await seedEditableSurveyFixture();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    if (!fx) return;
    await logMagicLinksOnFailure([fx.submittedStudent, fx.draftStudent, fx.correctionsStudent]);
  });

  test("a student cannot return their own submitted response to draft", async () => {
    const before = await readStoredResponse(fx.surveyId, fx.submittedStudent.private_profile_id);
    expect(before.is_submitted, "the fixture row must start out submitted").toBe(true);

    // The changed `response` rides along with the downgrade: the whole statement has to be
    // rejected, not just the boolean.
    const { data, error } = await patchOwnResponse(fx.submittedStudent, {
      is_submitted: false,
      response: { teamwork: EDITABLE_ANSWER_TEXT.downgradeAttempt, load: 1 }
    });

    expect(error, "the downgrade must be rejected, not silently dropped by RLS").not.toBeNull();
    expect(
      error!.code,
      `expected SQLSTATE 23514 (check_violation) from the trigger, got ${error!.code}: ${error!.message}`
    ).toBe("23514");
    expect(
      `${error!.message} ${error!.details ?? ""} ${error!.hint ?? ""}`,
      "the error must name the trigger, so a future unrelated 23514 cannot satisfy this test"
    ).toContain("survey_responses_no_unsubmit");
    expect(data ?? [], "a rejected statement returns no rows").toHaveLength(0);

    // Read with the service role so this sees the stored row, not the student's filtered view.
    const after = await readStoredResponse(fx.surveyId, fx.submittedStudent.private_profile_id);
    expect(after.is_submitted, "the row is still submitted").toBe(true);
    expect(after.response, "no part of the rejected statement landed").toMatchObject({
      teamwork: EDITABLE_ANSWER_TEXT.submittedOriginal
    });
    expect(after.submitted_at, "submitted_at is untouched").toBe(before.submitted_at);
  });

  test("a student can re-submit an editable response, keeping it submitted", async () => {
    // true -> true with a changed answer. This is the re-submit and autosave path on an editable
    // survey, and an over-broad trigger would break it.
    const { error } = await patchOwnResponse(fx.submittedStudent, {
      is_submitted: true,
      response: { teamwork: EDITABLE_ANSWER_TEXT.submittedRevised, load: 5 }
    });
    expect(error, `re-submitting an editable response must succeed: ${error?.message}`).toBeNull();

    const after = await readStoredResponse(fx.surveyId, fx.submittedStudent.private_profile_id);
    expect(after.is_submitted).toBe(true);
    expect(after.response).toMatchObject({ teamwork: EDITABLE_ANSWER_TEXT.submittedRevised });
  });

  test("a student can submit a draft response", async () => {
    const before = await readStoredResponse(fx.surveyId, fx.draftStudent.private_profile_id);
    expect(before.is_submitted, "the fixture row must start out as a draft").toBe(false);
    expect(before.submitted_at, "a draft has no submission timestamp").toBeNull();

    // false -> true, the ordinary submit.
    const { error } = await patchOwnResponse(fx.draftStudent, {
      is_submitted: true,
      response: { teamwork: EDITABLE_ANSWER_TEXT.draftSubmitted, load: 3 }
    });
    expect(error, `submitting a draft must succeed: ${error?.message}`).toBeNull();

    const after = await readStoredResponse(fx.surveyId, fx.draftStudent.private_profile_id);
    expect(after.is_submitted).toBe(true);
    expect(after.response).toMatchObject({ teamwork: EDITABLE_ANSWER_TEXT.draftSubmitted });
    expect(after.submitted_at, "set_survey_submitted_at stamps the false to true flip").not.toBeNull();
  });

  test("updates that leave is_submitted alone still go through", async () => {
    // The trigger's WHEN clause never fires on these, but a version written with a column list
    // (`UPDATE OF is_submitted`) or a broader condition would reject them. The soft delete matters
    // for seeding too: surveySubmissionSeeding.ts retracts a response exactly this way.
    const correctedAt = new Date("2035-01-02T03:04:05.000Z").toISOString();
    const { error: timestampError } = await patchOwnResponse(fx.correctionsStudent, {
      submitted_at: correctedAt
    });
    expect(
      timestampError,
      `correcting submitted_at on a submitted row must succeed: ${timestampError?.message}`
    ).toBeNull();

    const afterTimestamp = await readStoredResponse(fx.surveyId, fx.correctionsStudent.private_profile_id);
    expect(afterTimestamp.is_submitted).toBe(true);
    expect(new Date(afterTimestamp.submitted_at!).toISOString()).toBe(correctedAt);

    const deletedAt = new Date().toISOString();
    const { error: deleteError } = await patchOwnResponse(fx.correctionsStudent, { deleted_at: deletedAt });
    expect(deleteError, `soft-deleting a submitted row must succeed: ${deleteError?.message}`).toBeNull();

    const afterDelete = await readStoredResponse(fx.surveyId, fx.correctionsStudent.private_profile_id);
    expect(afterDelete.deleted_at, "the row is soft-deleted").not.toBeNull();
    expect(afterDelete.is_submitted, "a soft delete does not downgrade the row").toBe(true);
  });
});
