/**
 * DB-level coverage for `get_survey_responses_for_submission`.
 *
 * Two failures this suite exists to catch:
 *
 * 1. A group member with no `survey_responses` row silently disappearing. The RPC's whole purpose
 *    is answering "who has not filled this out yet", and turning the LEFT JOIN into an inner join
 *    (or moving `sr.deleted_at IS NULL` from the JOIN condition into the WHERE) drops exactly that
 *    member with no error and no empty state.
 *
 * 2. One student reading another student's survey answers. The function is SECURITY DEFINER, so
 *    RLS on `survey_responses` is not the backstop here; the WHERE clause is. Peer survey answers
 *    leaking between teammates is the worst thing this feature could do.
 *
 * No browser: every assertion goes through an authenticated PostgREST client, the same way
 * audit-leaderboard-rls-db.spec.ts does.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import { createAuthenticatedClient, insertAssignment, supabase, type TestingUser } from "./TestingUtils";
import {
  getSurveyResponsesForSubmission,
  seedSurveySubmissionFixture,
  SURVEY_ANSWER_TEXT,
  SURVEY_TITLES,
  type SurveyResponseForSubmissionRow,
  type SurveySubmissionFixture
} from "./surveySubmissionSeeding";

function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

test.describe("get_survey_responses_for_submission", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let fx: SurveySubmissionFixture;
  const clients = new Map<string, SupabaseClient<Database>>();

  /** Authenticated clients are expensive to mint (magic link round trip), so cache per user. */
  async function clientFor(user: TestingUser): Promise<SupabaseClient<Database>> {
    const cached = clients.get(user.email);
    if (cached) return cached;
    const created = await createAuthenticatedClient(user);
    clients.set(user.email, created);
    return created;
  }

  async function rowsFor(user: TestingUser, submissionId: number): Promise<SurveyResponseForSubmissionRow[]> {
    const client = await clientFor(user);
    const { data, error } = await getSurveyResponsesForSubmission(client, submissionId);
    expect(error, `RPC should not error for ${user.private_profile_name}: ${error?.message}`).toBeNull();
    return data ?? [];
  }

  function onSurvey(rows: SurveyResponseForSubmissionRow[], surveyId: string): SurveyResponseForSubmissionRow[] {
    return rows.filter((r) => r.survey_id === surveyId);
  }

  test.beforeAll(async () => {
    fx = await seedSurveySubmissionFixture();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    if (!fx) return;
    await logMagicLinksOnFailure([fx.instructor, fx.grader, fx.submitter, fx.teammate, fx.soloStudent]);
  });

  test("every group member comes back, including one who never started the survey", async () => {
    const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.publishedSurveyId);

    expect(
      rows.map((r) => r.profile_id).sort(),
      "the roster is every member of the submitting group, not just the ones who answered"
    ).toEqual(
      [
        fx.submitter.private_profile_id,
        fx.teammate.private_profile_id,
        fx.notStarted.private_profile_id,
        fx.softDeleted.private_profile_id
      ].sort()
    );

    // The single most important row in this suite. An inner join, or `sr.deleted_at IS NULL` moved
    // into the WHERE, would drop it and the UI would quietly stop reporting who is missing.
    const never = rows.find((r) => r.profile_id === fx.notStarted.private_profile_id);
    expect(never, "a member with no survey_responses row must still be returned").toBeDefined();
    expect(never!.is_submitted).toBe(false);
    expect(never!.response).toBeNull();
    expect(never!.submitted_at).toBeNull();
    expect(never!.updated_at).toBeNull();
    expect(never!.profile_name).toBe(fx.notStarted.private_profile_name);

    // A member who did answer carries the answer through.
    const answered = rows.find((r) => r.profile_id === fx.teammate.private_profile_id);
    expect(answered!.is_submitted).toBe(true);
    expect(answered!.response).toMatchObject({ teamwork: SURVEY_ANSWER_TEXT.teammate });
    expect(answered!.submitted_at).not.toBeNull();
  });

  test("a soft-deleted response is hidden, and the member reverts to not started", async () => {
    const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.publishedSurveyId);
    const retracted = rows.find((r) => r.profile_id === fx.softDeleted.private_profile_id);

    expect(retracted, "a member whose response was soft-deleted must still appear").toBeDefined();
    expect(retracted!.is_submitted, "a deleted response does not count as submitted").toBe(false);
    expect(retracted!.response, "a deleted response must not surface").toBeNull();
    expect(retracted!.submitted_at).toBeNull();
    expect(JSON.stringify(rows), "the retracted answer text must not appear anywhere in the result").not.toContain(
      SURVEY_ANSWER_TEXT.softDeleted
    );
  });

  test("is_submitter is true for exactly the submitting profile", async () => {
    const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.publishedSurveyId);
    const flagged = rows.filter((r) => r.is_submitter);

    expect(flagged, "exactly one roster row is the submitter").toHaveLength(1);
    expect(flagged[0].profile_id).toBe(fx.submitter.private_profile_id);
  });

  test("rows are ordered by survey title, then submitter first, then profile name", async () => {
    const rows = await rowsFor(fx.instructor, fx.groupSubmissionId);

    const titles = [...new Set(rows.map((r) => r.survey_title))];
    expect(titles, "surveys come back in title order").toEqual([...titles].sort());

    const published = onSurvey(rows, fx.publishedSurveyId);
    expect(published[0].is_submitter, "the submitter sorts first within a survey").toBe(true);
    const rest = published.slice(1).map((r) => r.profile_name);
    expect(rest, "the remaining members sort by profile name").toEqual([...rest].sort());
  });

  test("a solo submission returns just the one profile", async () => {
    const rows = onSurvey(await rowsFor(fx.instructor, fx.soloSubmissionId), fx.publishedSurveyId);

    expect(rows, "a submission with no group has a roster of one").toHaveLength(1);
    expect(rows[0].profile_id).toBe(fx.soloStudent.private_profile_id);
    expect(rows[0].is_submitter).toBe(true);
    expect(rows[0].is_submitted).toBe(true);
  });

  test("a submission whose assignment has no linked survey returns nothing", async () => {
    const rows = await rowsFor(fx.instructor, fx.surveylessSubmissionId);
    expect(rows, "no linked survey means no rows, for staff as well as students").toHaveLength(0);
  });

  test.describe("authorization", () => {
    test("an instructor in the class sees every group member", async () => {
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.publishedSurveyId);
      expect(rows).toHaveLength(4);
    });

    test("a grader in the class sees every group member", async () => {
      const rows = onSurvey(await rowsFor(fx.grader, fx.groupSubmissionId), fx.publishedSurveyId);
      expect(rows, "authorizeforclassgrader covers the grader role, not just instructor").toHaveLength(4);
      expect(rows.map((r) => r.profile_id).sort()).toEqual(
        [
          fx.submitter.private_profile_id,
          fx.teammate.private_profile_id,
          fx.notStarted.private_profile_id,
          fx.softDeleted.private_profile_id
        ].sort()
      );
    });

    test("the submitting student sees only their own row, never a teammate's", async () => {
      const rows = onSurvey(await rowsFor(fx.submitter, fx.groupSubmissionId), fx.publishedSurveyId);

      expect(rows, "a student's roster is their own profile").toHaveLength(1);
      expect(rows[0].profile_id).toBe(fx.submitter.private_profile_id);
      expect(JSON.stringify(rows), "a teammate's free-text answer must never reach another student").not.toContain(
        SURVEY_ANSWER_TEXT.teammate
      );
    });

    test("a group member who is not the submitter sees only their own row", async () => {
      const rows = onSurvey(await rowsFor(fx.teammate, fx.groupSubmissionId), fx.publishedSurveyId);

      expect(rows).toHaveLength(1);
      expect(rows[0].profile_id).toBe(fx.teammate.private_profile_id);
      expect(rows[0].is_submitter, "the teammate is on the submission but did not submit it").toBe(false);
      expect(JSON.stringify(rows)).not.toContain(SURVEY_ANSWER_TEXT.submitter);
    });

    test("a group member who never started sees their own empty row and nothing else", async () => {
      const rows = onSurvey(await rowsFor(fx.notStarted, fx.groupSubmissionId), fx.publishedSurveyId);

      expect(rows).toHaveLength(1);
      expect(rows[0].profile_id).toBe(fx.notStarted.private_profile_id);
      expect(rows[0].is_submitted).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(SURVEY_ANSWER_TEXT.teammate);
    });

    test("a student enrolled in the class but unrelated to the submission gets zero rows", async () => {
      // Sol is enrolled and has her own submission on this assignment, but she is not a member of
      // the submitting group. Her own solo submission still resolves, so this is not a blanket deny.
      const foreign = await rowsFor(fx.soloStudent, fx.groupSubmissionId);
      expect(foreign, "an enrolled outsider must not read a group's survey responses").toHaveLength(0);

      const own = await rowsFor(fx.soloStudent, fx.soloSubmissionId);
      expect(own.length, "the same student still reads her own submission").toBeGreaterThan(0);
    });

    test("a user enrolled in a different class gets zero rows", async () => {
      // An instructor elsewhere is the worst case: staff privileges, wrong class. `authorizeforclass`
      // is scoped to the submission's class, so this must come back empty rather than fully populated.
      const rows = await rowsFor(fx.otherClassInstructor, fx.groupSubmissionId);
      expect(rows, "staff in another class must not read this class's survey responses").toHaveLength(0);
    });

    test("an unauthenticated caller cannot execute the function", async () => {
      const { data, error } = await getSurveyResponsesForSubmission(anonClient(), fx.groupSubmissionId);
      expect(data ?? [], "anon must never read survey responses").toHaveLength(0);
      // EXECUTE is granted to `authenticated` only, so PostgREST answers 42501 rather than an
      // empty set. Accept either, but never rows.
      if (error) expect(error.code).toBe("42501");
    });

    test("the service role is not a back door into the authenticated-only grant", async () => {
      // `supabase` here is the service-role client. auth.uid() is null for it, so even if a future
      // GRANT widens EXECUTE, the WHERE clause still denies. Pinning this keeps the admin client
      // from becoming an accidental bypass that a test could rely on.
      const { data } = await getSurveyResponsesForSubmission(supabase, fx.groupSubmissionId);
      expect(data ?? [], "service role has no auth.uid(), so the authorization guard denies").toHaveLength(0);
    });
  });

  test.describe("which surveys are included", () => {
    test("a draft survey linked to the assignment is excluded", async () => {
      const rows = await rowsFor(fx.instructor, fx.groupSubmissionId);

      expect(onSurvey(rows, fx.draftSurveyId), "a draft survey must not reach the submission view").toHaveLength(0);
      expect(rows.map((r) => r.survey_title)).not.toContain(SURVEY_TITLES.draft);
    });

    test("a closed survey is included", async () => {
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.closedSurveyId);

      expect(rows, "a closed survey still has responses worth grading against").toHaveLength(4);
      expect(rows[0].survey_status).toBe("closed");
      expect(rows[0].survey_title).toBe(SURVEY_TITLES.closed);
    });

    test("a survey whose available_at is in the future IS returned", async () => {
      // Deliberately unfiltered, unlike get_survey_status_for_assignment. The UI needs the row so it
      // can badge the survey as not yet open. Do not "helpfully" add the available_at filter here:
      // graders would lose visibility into a survey the moment it is scheduled ahead.
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.futureSurveyId);

      expect(rows, "available_at must not be filtered on").toHaveLength(4);
      expect(rows[0].available_at, "available_at is returned so the UI can badge it").not.toBeNull();
      expect(new Date(rows[0].available_at!).getTime()).toBeGreaterThan(Date.now());
    });

    test("a survey linked to a different assignment does not leak in", async () => {
      const sibling = await insertAssignment({
        due_date: addDays(new Date(), 12).toISOString(),
        class_id: fx.course.id,
        name: "Sibling Assignment",
        assignment_slug: `survey-on-submission-sibling-${fx.course.id}`
      });
      const { data: otherAssignmentSurvey, error } = await supabase
        .from("surveys")
        .insert({
          class_id: fx.course.id,
          created_by: fx.instructor.public_profile_id,
          assignment_id: sibling.id,
          assigned_to_all: true,
          allow_response_editing: false,
          json: {},
          version: 1,
          status: "published",
          title: "Z Other Assignment Survey",
          description: "Linked to a different assignment in the same class"
        })
        .select("id")
        .single();
      expect(error).toBeNull();

      const rows = await rowsFor(fx.instructor, fx.groupSubmissionId);
      expect(
        rows.map((r) => r.survey_id),
        "surveys are selected by the submission's assignment, not by class"
      ).not.toContain(otherAssignmentSurvey!.id);
    });

    test("the returned survey_json is the SurveyJS model the UI renders", async () => {
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.publishedSurveyId);
      const pages = (rows[0].survey_json as { pages?: unknown[] } | null)?.pages;
      expect(Array.isArray(pages), "survey_json carries surveys.json through unchanged").toBe(true);
    });
  });
});
