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
  UNASSIGNED_SURVEY_QUESTION_TEXT,
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
    await logMagicLinksOnFailure([fx.instructor, fx.grader, fx.submitter, fx.teammate, fx.notStarted, fx.soloStudent]);
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

    test("a survey whose available_at is in the future IS returned to staff", async () => {
      // Unfiltered for staff, unlike get_survey_status_for_assignment. A grader needs the row so
      // the UI can badge the survey as not yet open; scheduling a survey ahead must not blank out
      // the grading view. The student half of this rule is in "student visibility" below, and the
      // two assertions only make sense as a pair: filtering available_at for everyone breaks this
      // test, filtering it for nobody breaks that one.
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.futureSurveyId);

      expect(rows, "available_at must not be filtered on for staff").toHaveLength(4);
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

  /**
   * The RPC is SECURITY DEFINER, so `surveys_select_students` never runs inside it. Everything that
   * policy decides — published-or-closed, `available_at` reached, and assigned either through
   * `assigned_to_all` or a `survey_assignments` row — has to be restated in the function body for
   * non-staff callers, or a student reads a survey they were never given.
   *
   * These cases are paired on purpose. Each "a student must not see this" has a matching "staff
   * must still see it", because the cheap way to make a leak test pass is to filter for everyone,
   * and that silently removes scheduled surveys from the grading view.
   */
  test.describe("student visibility matches surveys_select_students", () => {
    test("an unreleased, unassigned survey leaks neither rows nor question text to a group member", async () => {
      for (const student of [fx.submitter, fx.teammate, fx.notStarted]) {
        const all = await rowsFor(student, fx.groupSubmissionId);

        // Positive control first: this student does read the submission, so the emptiness below is
        // the visibility predicate doing its job and not an authorization failure or a bad id.
        expect(all.length, `${student.private_profile_name} still reads their own survey rows`).toBeGreaterThan(0);

        expect(
          onSurvey(all, fx.unassignedFutureSurveyId),
          `${student.private_profile_name} was never assigned this survey and it is not open yet`
        ).toHaveLength(0);

        // Row count alone is not enough. `survey_json` travels on every row, so a join that leaks
        // the wrong survey's model onto a row the student is allowed to see would still pass the
        // count check while handing over the unreleased questions verbatim.
        expect(
          JSON.stringify(all),
          `the unreleased survey's question text must not appear anywhere in ${student.private_profile_name}'s payload`
        ).not.toContain(UNASSIGNED_SURVEY_QUESTION_TEXT);
      }
    });

    test("staff still see the unreleased, unassigned survey and its whole roster", async () => {
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.unassignedFutureSurveyId);

      expect(rows, "an instructor sees every group member on a survey assigned to none of them").toHaveLength(4);
      expect(rows[0].survey_title).toBe(SURVEY_TITLES.unassignedFuture);
      expect(rows[0].available_at, "staff visibility does not depend on available_at").not.toBeNull();
      expect(new Date(rows[0].available_at!).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify(rows), "staff do get the survey model: this is the text a student must not get").toContain(
        UNASSIGNED_SURVEY_QUESTION_TEXT
      );
    });

    test("an assigned_to_all survey that is not yet open does not reach a student", async () => {
      // The same survey the staff-side test above asserts IS returned. `assigned_to_all` is true
      // here, so this isolates the availability half of the predicate from the assignment half.
      const all = await rowsFor(fx.submitter, fx.groupSubmissionId);
      expect(all.length, "the caller reads the submission at all").toBeGreaterThan(0);
      expect(onSurvey(all, fx.futureSurveyId), "a student cannot see a survey scheduled ahead").toHaveLength(0);
    });

    test("a published survey whose available_at has passed is returned to the student", async () => {
      // The ordinary case, and the reason the two tests above cannot be satisfied by refusing
      // everything: over-filtering shows up here.
      const rows = onSurvey(await rowsFor(fx.submitter, fx.groupSubmissionId), fx.openNowSurveyId);

      expect(rows, "a student sees their own row on an open, assigned-to-all survey").toHaveLength(1);
      expect(rows[0].profile_id).toBe(fx.submitter.private_profile_id);
      expect(rows[0].survey_title).toBe(SURVEY_TITLES.openNow);
      expect(new Date(rows[0].available_at!).getTime()).toBeLessThan(Date.now());
      expect(rows[0].is_assigned).toBe(true);
    });

    test("a student named in survey_assignments by public profile id still sees their survey", async () => {
      // The fixture writes that row under the PUBLIC profile id, which is what the assignment UI
      // can hand `create_survey_assignments`. The RPC's roster is keyed by private profile id, so a
      // visibility join written only against the private id hides this student's own survey from
      // them — a failure no private-id fixture would ever reproduce.
      const rows = onSurvey(await rowsFor(fx.targetedStudent, fx.groupSubmissionId), fx.targetedSurveyId);

      expect(rows, "the assigned student gets exactly their own row").toHaveLength(1);
      expect(rows[0].profile_id).toBe(fx.targetedStudent.private_profile_id);
      expect(rows[0].survey_title).toBe(SURVEY_TITLES.targeted);
      expect(rows[0].is_assigned, "a survey_assignments match on either profile id counts").toBe(true);
    });

    test("a group member with no survey_assignments row does not see the targeted survey", async () => {
      const all = await rowsFor(fx.untargetedStudent, fx.groupSubmissionId);

      expect(all.length, "this member still reads the surveys they were assigned").toBeGreaterThan(0);
      expect(
        onSurvey(all, fx.targetedSurveyId),
        "being a teammate of an assigned student does not assign you the survey"
      ).toHaveLength(0);
    });
  });

  test.describe("is_assigned", () => {
    test("is true for every member of an assigned_to_all survey", async () => {
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.publishedSurveyId);

      expect(rows).toHaveLength(4);
      expect(
        rows.map((r) => r.is_assigned),
        "assigned_to_all assigns the survey to everyone without any survey_assignments rows"
      ).toEqual([true, true, true, true]);
    });

    test("distinguishes an unassigned member from one who simply has not started", async () => {
      // The reason this column exists. Without it the UI reads `response == null` and labels an
      // unassigned member "Not started", which blames a student for missing work never asked of
      // them. Both members here have a null response; only one of them was assigned.
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.targetedSurveyId);

      expect(rows, "the roster is the group, not the assignment list").toHaveLength(4);

      const assigned = rows.find((r) => r.profile_id === fx.targetedStudent.private_profile_id);
      expect(assigned, "the assigned member is on the roster").toBeDefined();
      expect(assigned!.is_assigned).toBe(true);
      expect(assigned!.response, "assigned, and has not answered: the genuine 'not started'").toBeNull();

      const unassigned = rows.find((r) => r.profile_id === fx.untargetedStudent.private_profile_id);
      expect(
        unassigned,
        "an unassigned member must not vanish from a grader's roster: the grader needs to see why"
      ).toBeDefined();
      expect(unassigned!.is_assigned).toBe(false);
      expect(unassigned!.response).toBeNull();

      expect(
        rows.filter((r) => r.is_assigned).map((r) => r.profile_id),
        "exactly the one profile named in survey_assignments is assigned"
      ).toEqual([fx.targetedStudent.private_profile_id]);
    });

    test("is a non-null boolean on every row", async () => {
      // A null here is worse than a wrong value: the UI branches on it, and `null` would fall
      // through to whatever the "not assigned" branch is for a member who was in fact assigned.
      const rows = await rowsFor(fx.instructor, fx.groupSubmissionId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(typeof row.is_assigned, `is_assigned on ${row.survey_title}/${row.profile_name}`).toBe("boolean");
      }
    });

    test("does not suppress the answer of a member who was unassigned after responding", async () => {
      // `is_assigned` is about who was asked, not about what exists. `create_survey_assignments`
      // clears and rewrites the whole assignee list, so dropping one name leaves that student's
      // `survey_responses` row intact and their `survey_assignments` row gone. The RPC must keep
      // returning the answer: it is real work, and a grader reading "not assigned" instead would
      // record no participation for a student whose response is sitting in the table.
      const rows = onSurvey(await rowsFor(fx.instructor, fx.groupSubmissionId), fx.revokedSurveyId);

      expect(rows, "the whole roster comes back, assigned or not").toHaveLength(4);

      const answered = rows.find((r) => r.profile_id === fx.revokedStudent.private_profile_id);
      expect(answered, "the member who answered is on the roster").toBeDefined();
      expect(answered!.is_assigned, "their assignment row was removed").toBe(false);
      expect(answered!.response, "their answer was not removed with it").not.toBeNull();
      expect(answered!.response).toMatchObject({ teamwork: SURVEY_ANSWER_TEXT.revoked });
      expect(answered!.is_submitted).toBe(true);
      expect(answered!.submitted_at).not.toBeNull();

      // The contrast that makes `is_assigned: false` alone useless as a render signal: on this
      // same survey another member is equally unassigned and has nothing to show. Only `response`
      // separates them, which is why it is checked first.
      const silent = rows.find((r) => r.profile_id === fx.notStarted.private_profile_id);
      expect(silent!.is_assigned).toBe(false);
      expect(silent!.response).toBeNull();
    });

    test("an unassigned member cannot read back their own answer through the student path", async () => {
      // A consequence of restating `surveys_select_students`, pinned here so it is a decision
      // rather than a surprise: once the assignment is revoked the survey fails the student
      // predicate, so its author can no longer reach their own response through this RPC. The
      // same student's answer is still fully visible to staff (asserted above), and the survey
      // page applies the identical rule through RLS, so this is consistent rather than novel.
      const all = await rowsFor(fx.revokedStudent, fx.groupSubmissionId);

      expect(all.length, "the student still reads the surveys they are assigned").toBeGreaterThan(0);
      expect(onSurvey(all, fx.revokedSurveyId), "an unassigned survey is withheld from the student").toHaveLength(0);
    });
  });
});
