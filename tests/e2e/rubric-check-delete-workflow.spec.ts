import { addDays } from "date-fns";
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import type { Locator, Page } from "@playwright/test";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";
import { parseDeletedRubricChecksReport, parseRubricCheckDeletionPreview } from "@/lib/rubric/deletionReport";

dotenv.config({ path: ".env.local", quiet: true });

function rubricEditor(page: Page): Locator {
  return page.getByRole("region", { name: "Rubric Editor" });
}

type BuiltPayloadCheck = {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  data: unknown;
  file: string | null;
  artifact: string | null;
  group: string | null;
  is_annotation: boolean;
  is_comment_required: boolean;
  is_required: boolean;
  max_annotations: number | null;
  points: number | null;
  annotation_target: string | null;
  student_visibility: string;
  kpi_category: string | null;
  references: Array<{ referenced_rubric_check_id: number }>;
};

/**
 * Fetches a rubric from DB and serializes it into the JSON payload expected by
 * `update_rubric_full` / `update_rubric_full_with_report`, optionally omitting check IDs.
 */
async function buildRubricPayloadFromDb(rubricId: number, omitCheckIds: number[] = []) {
  const omit = new Set(omitCheckIds);
  const { data: rubric, error: rErr } = await supabase.from("rubrics").select("*").eq("id", rubricId).single();
  if (rErr || !rubric) throw new Error(`Failed to fetch rubric ${rubricId}: ${rErr?.message}`);

  const { data: parts, error: pErr } = await supabase
    .from("rubric_parts")
    .select("*")
    .eq("rubric_id", rubricId)
    .order("ordinal");
  if (pErr) throw pErr;

  const { data: criteria, error: cErr } = await supabase
    .from("rubric_criteria")
    .select("*")
    .eq("rubric_id", rubricId)
    .order("ordinal");
  if (cErr) throw cErr;

  const criteriaIds = (criteria ?? []).map((c) => c.id);
  const { data: checks, error: kErr } =
    criteriaIds.length > 0
      ? await supabase.from("rubric_checks").select("*").in("rubric_criteria_id", criteriaIds).order("ordinal")
      : { data: [], error: null };
  if (kErr) throw kErr;

  return {
    id: rubric.id,
    class_id: rubric.class_id,
    assignment_id: rubric.assignment_id,
    review_round: rubric.review_round,
    name: rubric.name,
    description: rubric.description,
    is_private: rubric.is_private,
    cap_score_to_assignment_points: rubric.cap_score_to_assignment_points,
    hide_unless_assigned: rubric.hide_unless_assigned,
    parts: (parts ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      ordinal: p.ordinal,
      data: p.data,
      is_individual_grading: p.is_individual_grading,
      is_assign_to_student: p.is_assign_to_student,
      criteria: (criteria ?? [])
        .filter((c) => c.rubric_part_id === p.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          ordinal: c.ordinal,
          data: c.data,
          is_additive: c.is_additive,
          is_deduction_only: c.is_deduction_only,
          total_points: c.total_points,
          max_checks_per_submission: c.max_checks_per_submission,
          min_checks_per_submission: c.min_checks_per_submission,
          checks: (checks ?? [])
            .filter((k) => k.rubric_criteria_id === c.id && !omit.has(k.id))
            .map(
              (k): BuiltPayloadCheck => ({
                id: k.id,
                name: k.name,
                description: k.description,
                ordinal: k.ordinal,
                data: k.data,
                file: k.file,
                artifact: k.artifact,
                group: k.group,
                is_annotation: k.is_annotation,
                is_comment_required: k.is_comment_required,
                is_required: k.is_required,
                max_annotations: k.max_annotations,
                points: k.points,
                annotation_target: k.annotation_target,
                student_visibility: k.student_visibility,
                kpi_category: k.kpi_category,
                references: []
              })
            )
        }))
    }))
  };
}

test.describe("Rubric check deletion workflow (DB & RPC)", () => {
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let student: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;
  let rubricId: number;
  let partId: number;
  let criteriaId: number;
  let checkSoftDeletedOnlyId: number;
  let checkMultiTableActiveId: number;
  let checkBareRegradeId: number;
  let checkToctouId: number;
  let submissionId: number;
  let gradingReviewId: number;
  let submissionFileId: number;
  let artifactId: number;
  let softDeletedCommentId: number;
  let activeSubCommentId: number;
  let activeFileCommentId: number;
  let activeArtifactCommentId: number;
  let commentRegradeId: number;
  let bareRegradeId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: "E2E Rubric Check Delete DB" });
    instructor = await createUserInClass({
      name: "Prof Delete Tester",
      role: "instructor",
      class_id: course.id
    });
    grader = await createUserInClass({
      name: "Grace Real Grader",
      role: "grader",
      class_id: course.id
    });
    student = await createUserInClass({
      name: "Sam Student",
      role: "student",
      class_id: course.id
    });

    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 7).toISOString(),
      name: "Check Delete RPC Assignment"
    });
    rubricId = assignment.grading_rubric_id!;

    const { data: part, error: pErr } = await supabase
      .from("rubric_parts")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        rubric_id: rubricId,
        name: "Deletion Test Part",
        ordinal: 99
      })
      .select("id")
      .single();
    expect(pErr).toBeNull();
    partId = part!.id;

    const { data: crit, error: cErr } = await supabase
      .from("rubric_criteria")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        rubric_id: rubricId,
        rubric_part_id: partId,
        name: "Deletion Test Criterion",
        ordinal: 0,
        is_additive: true,
        total_points: 20
      })
      .select("id")
      .single();
    expect(cErr).toBeNull();
    criteriaId = crit!.id;

    const insertCheck = async (name: string, points: number, ordinal: number) => {
      const { data, error } = await supabase
        .from("rubric_checks")
        .insert({
          class_id: course.id,
          assignment_id: assignment.id,
          rubric_id: rubricId,
          rubric_criteria_id: criteriaId,
          name,
          points,
          ordinal,
          is_annotation: false,
          is_comment_required: false,
          is_required: false,
          student_visibility: "always"
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      return data!.id;
    };

    checkSoftDeletedOnlyId = await insertCheck("Soft-Deleted Only Check", 3, 0);
    checkMultiTableActiveId = await insertCheck("Multi-Table Active Check", 5, 1);
    checkBareRegradeId = await insertCheck("Bare Regrade Check", 4, 2);
    checkToctouId = await insertCheck("TOCTOU Race Check", 2, 3);

    const sub = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    submissionId = sub.submission_id;
    gradingReviewId = sub.grading_review_id;

    // Mark review released to test released-submission reporting
    const { error: relErr } = await supabase
      .from("submission_reviews")
      .update({ released: true })
      .eq("id", gradingReviewId);
    expect(relErr).toBeNull();

    const { data: fileRow, error: fErr } = await supabase
      .from("submission_files")
      .select("id")
      .eq("submission_id", submissionId)
      .limit(1)
      .single();
    expect(fErr).toBeNull();
    submissionFileId = fileRow!.id;

    const { data: artifactRow, error: aErr } = await supabase
      .from("submission_artifacts")
      .insert({
        class_id: course.id,
        submission_id: submissionId,
        name: "architecture.pdf",
        profile_id: student.private_profile_id
      })
      .select("id")
      .single();
    expect(aErr).toBeNull();
    artifactId = artifactRow!.id;

    // 1. Soft-deleted-only comment on checkSoftDeletedOnlyId
    const { data: sdRow, error: sdErr } = await supabase
      .from("submission_comments")
      .insert({
        class_id: course.id,
        submission_id: submissionId,
        submission_review_id: gradingReviewId,
        rubric_check_id: checkSoftDeletedOnlyId,
        author: grader.private_profile_id,
        comment: "Already deleted by grader",
        points: 3,
        released: true,
        deleted_at: new Date().toISOString()
      })
      .select("id")
      .single();
    expect(sdErr).toBeNull();
    softDeletedCommentId = sdRow!.id;

    // 2. Active comments across all 3 tables on checkMultiTableActiveId, authored under grader's PUBLIC profile
    // (to verify pseudonymous grader resolution resolves real name & email!)
    const { data: scRow, error: scErr } = await supabase
      .from("submission_comments")
      .insert({
        class_id: course.id,
        submission_id: submissionId,
        submission_review_id: gradingReviewId,
        rubric_check_id: checkMultiTableActiveId,
        author: grader.public_profile_id,
        comment: "Active submission comment",
        points: 5,
        released: true
      })
      .select("id")
      .single();
    expect(scErr).toBeNull();
    activeSubCommentId = scRow!.id;

    const { data: fcRow, error: fcErr } = await supabase
      .from("submission_file_comments")
      .insert({
        class_id: course.id,
        submission_id: submissionId,
        submission_file_id: submissionFileId,
        submission_review_id: gradingReviewId,
        rubric_check_id: checkMultiTableActiveId,
        author: grader.public_profile_id,
        comment: "Active file comment",
        line: 1,
        points: 2,
        released: true
      })
      .select("id")
      .single();
    expect(fcErr).toBeNull();
    activeFileCommentId = fcRow!.id;

    const { data: acRow, error: acErr } = await supabase
      .from("submission_artifact_comments")
      .insert({
        class_id: course.id,
        submission_id: submissionId,
        submission_artifact_id: artifactId,
        submission_review_id: gradingReviewId,
        rubric_check_id: checkMultiTableActiveId,
        author: grader.public_profile_id,
        comment: "Active artifact comment",
        points: 1,
        released: true
      })
      .select("id")
      .single();
    expect(acErr).toBeNull();
    activeArtifactCommentId = acRow!.id;

    // 3. Regrade request backed by activeSubCommentId
    const { data: crRow, error: crErr } = await supabase
      .from("submission_regrade_requests")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        submission_id: submissionId,
        submission_comment_id: activeSubCommentId,
        rubric_check_id: checkMultiTableActiveId,
        created_by: student.private_profile_id,
        assignee: grader.private_profile_id,
        status: "opened"
      })
      .select("id")
      .single();
    expect(crErr).toBeNull();
    commentRegradeId = crRow!.id;
    const { error: linkErr } = await supabase
      .from("submission_comments")
      .update({ regrade_request_id: commentRegradeId })
      .eq("id", activeSubCommentId);
    expect(linkErr).toBeNull();

    // 4. Bare-check regrade request on checkBareRegradeId (no comment attached)
    const { data: brRow, error: brErr } = await supabase
      .from("submission_regrade_requests")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        submission_id: submissionId,
        rubric_check_id: checkBareRegradeId,
        created_by: student.private_profile_id,
        assignee: grader.private_profile_id,
        status: "opened"
      })
      .select("id")
      .single();
    expect(brErr).toBeNull();
    bareRegradeId = brRow!.id;

    // 5. Active comment on checkToctouId
    const { error: tErr } = await supabase.from("submission_comments").insert({
      class_id: course.id,
      submission_id: submissionId,
      submission_review_id: gradingReviewId,
      rubric_check_id: checkToctouId,
      author: grader.private_profile_id,
      comment: "Initial TOCTOU comment",
      points: 2,
      released: true
    });
    expect(tErr).toBeNull();
  });

  test("plain grader without manage_rubrics is denied preview and save RPCs", async () => {
    const graderClient = await createAuthenticatedClient(grader);
    const { error: prevErr } = await graderClient.rpc("preview_rubric_check_deletions", {
      p_rubric_id: rubricId,
      p_removed_check_ids: [checkMultiTableActiveId]
    });
    expect(prevErr?.code).toBe("42501");

    const payload = await buildRubricPayloadFromDb(rubricId);
    const { error: saveErr } = await graderClient.rpc("update_rubric_full_with_report", {
      p_rubric: payload as never
    });
    expect(saveErr?.code).toBe("42501");
  });

  test("check with ONLY soft-deleted comments previews empty and deletes cleanly without confirmation", async () => {
    const instructorClient = await createAuthenticatedClient(instructor);

    const { data: previewRaw, error: prevErr } = await instructorClient.rpc("preview_rubric_check_deletions", {
      p_rubric_id: rubricId,
      p_removed_check_ids: [checkSoftDeletedOnlyId]
    });
    expect(prevErr).toBeNull();
    const preview = parseRubricCheckDeletionPreview(previewRaw);
    expect(preview.checks).toHaveLength(0);

    const payload = await buildRubricPayloadFromDb(rubricId, [checkSoftDeletedOnlyId]);
    const { data: saveData, error: saveErr } = await instructorClient.rpc("update_rubric_full_with_report", {
      p_rubric: payload as never
    });
    expect(saveErr).toBeNull();
    const parsed = saveData as { summary?: string; deleted_checks_report?: unknown };
    expect(typeof parsed.summary).toBe("string");
    expect(parseDeletedRubricChecksReport(parsed.deleted_checks_report)).toBeNull();

    // Check is deleted, and soft-deleted comment was detached (rubric_check_id IS NULL) while staying soft-deleted
    const { data: checkRow } = await supabase
      .from("rubric_checks")
      .select("id")
      .eq("id", checkSoftDeletedOnlyId)
      .maybeSingle();
    expect(checkRow).toBeNull();

    const { data: commentRow } = await supabase
      .from("submission_comments")
      .select("id, rubric_check_id, deleted_at")
      .eq("id", softDeletedCommentId)
      .single();
    expect(commentRow?.rubric_check_id).toBeNull();
    expect(commentRow?.deleted_at).not.toBeNull();
  });

  test("active comments across all 3 tables + bare regrade require confirmation, resolve pseudonymous grader, soft-delete, detach, close regrades, and recompute score", async () => {
    const instructorClient = await createAuthenticatedClient(instructor);

    // 1. Preview returns real grader identity, all 3 comment types, released count, and bare regrade
    const { data: previewRaw, error: prevErr } = await instructorClient.rpc("preview_rubric_check_deletions", {
      p_rubric_id: rubricId,
      p_removed_check_ids: [checkMultiTableActiveId, checkBareRegradeId]
    });
    expect(prevErr).toBeNull();
    const preview = parseRubricCheckDeletionPreview(previewRaw);
    expect(preview.checks).toHaveLength(2);

    const activeCheckImpact = preview.checks.find((c) => c.check_id === checkMultiTableActiveId)!;
    expect(activeCheckImpact).toBeDefined();
    expect(activeCheckImpact.comment_count).toBe(3);
    expect(activeCheckImpact.submission_count).toBe(1);
    expect(activeCheckImpact.released_submission_count).toBe(1);
    expect(activeCheckImpact.active_regrade_request_count).toBe(1);
    expect(new Set(activeCheckImpact.applications.map((a) => a.comment_type))).toEqual(
      new Set(["submission", "file", "artifact"])
    );
    // Real grader name & email resolved even though comments were authored via public_profile_id
    for (const app of activeCheckImpact.applications) {
      expect(app.grader_name).toBe("Grace Real Grader");
      expect(app.grader_email).toBe(grader.email);
      expect(app.student_or_group_name).toBe("Sam Student");
    }

    const bareImpact = preview.checks.find((c) => c.check_id === checkBareRegradeId)!;
    expect(bareImpact).toBeDefined();
    expect(bareImpact.comment_count).toBe(0);
    expect(bareImpact.bare_regrade_request_count).toBe(1);
    expect(bareImpact.bare_regrade_requests[0].regrade_request_id).toBe(bareRegradeId);

    // 2. Unconfirmed save is refused with 23503 + hint rubric_checks_in_use
    const payload = await buildRubricPayloadFromDb(rubricId, [checkMultiTableActiveId, checkBareRegradeId]);
    const { error: unconfirmedErr } = await instructorClient.rpc("update_rubric_full_with_report", {
      p_rubric: payload as never
    });
    expect(unconfirmedErr?.code).toBe("23503");
    expect(unconfirmedErr?.hint).toBe("rubric_checks_in_use");

    // Record score before deletion
    const { data: reviewBefore } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", gradingReviewId)
      .single();

    // 3. Confirmed save succeeds and returns full follow-up report
    const { data: confirmedData, error: confirmedErr } = await instructorClient.rpc("update_rubric_full_with_report", {
      p_rubric: payload as never,
      p_confirm_delete_check_ids: [checkMultiTableActiveId, checkBareRegradeId],
      p_previewed_at: preview.previewed_at,
      p_expected_active_comment_count: 3
    });
    expect(confirmedErr).toBeNull();

    const reportObj = confirmedData as { summary?: string; deleted_checks_report?: unknown };
    const report = parseDeletedRubricChecksReport(reportObj.deleted_checks_report);
    expect(report).not.toBeNull();
    expect(report!.checks).toHaveLength(2);

    // Verify all 3 comments are soft-deleted and detached
    const { data: scAfter } = await supabase
      .from("submission_comments")
      .select("deleted_at, rubric_check_id, edited_by")
      .eq("id", activeSubCommentId)
      .single();
    expect(scAfter?.deleted_at).not.toBeNull();
    expect(scAfter?.rubric_check_id).toBeNull();
    expect(scAfter?.edited_by).toBe(instructor.private_profile_id);

    const { data: fcAfter } = await supabase
      .from("submission_file_comments")
      .select("deleted_at, rubric_check_id, edited_by")
      .eq("id", activeFileCommentId)
      .single();
    expect(fcAfter?.deleted_at).not.toBeNull();
    expect(fcAfter?.rubric_check_id).toBeNull();
    expect(fcAfter?.edited_by).toBe(instructor.private_profile_id);

    const { data: acAfter } = await supabase
      .from("submission_artifact_comments")
      .select("deleted_at, rubric_check_id, edited_by")
      .eq("id", activeArtifactCommentId)
      .single();
    expect(acAfter?.deleted_at).not.toBeNull();
    expect(acAfter?.rubric_check_id).toBeNull();
    expect(acAfter?.edited_by).toBe(instructor.private_profile_id);

    // Verify both regrade requests were detached and closed with rubric_check_deleted
    const { data: regradesAfter } = await supabase
      .from("submission_regrade_requests")
      .select("id, rubric_check_id, status, resolution_reason")
      .in("id", [commentRegradeId, bareRegradeId]);
    expect(regradesAfter).toHaveLength(2);
    for (const r of regradesAfter ?? []) {
      expect(r.rubric_check_id).toBeNull();
      expect(r.status).toBe("resolved");
      expect(r.resolution_reason).toBe("rubric_check_deleted");
    }

    // Verify score recomputed downward (only checkToctouId's 2 points remain)
    const { data: reviewAfter } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", gradingReviewId)
      .single();
    expect(reviewAfter!.total_score).toBeLessThan(reviewBefore!.total_score);
    expect(reviewAfter!.total_score).toBe(reviewBefore!.total_score - 8);
  });

  test("TOCTOU guard rejects confirmation when a new active comment arrives after preview", async () => {
    const instructorClient = await createAuthenticatedClient(instructor);

    const { data: previewRaw, error: prevErr } = await instructorClient.rpc("preview_rubric_check_deletions", {
      p_rubric_id: rubricId,
      p_removed_check_ids: [checkToctouId]
    });
    expect(prevErr).toBeNull();
    const preview = parseRubricCheckDeletionPreview(previewRaw);
    expect(preview.checks).toHaveLength(1);
    expect(preview.checks[0].comment_count).toBe(1);

    // Simulate concurrent grader applying the check AFTER the preview was taken
    const { error: raceErr } = await supabase.from("submission_comments").insert({
      class_id: course.id,
      submission_id: submissionId,
      submission_review_id: gradingReviewId,
      rubric_check_id: checkToctouId,
      author: grader.private_profile_id,
      comment: "Concurrent comment added after preview",
      points: 2,
      released: true
    });
    expect(raceErr).toBeNull();

    const payload = await buildRubricPayloadFromDb(rubricId, [checkToctouId]);
    const { error: staleErr } = await instructorClient.rpc("update_rubric_full_with_report", {
      p_rubric: payload as never,
      p_confirm_delete_check_ids: [checkToctouId],
      p_previewed_at: preview.previewed_at,
      p_expected_active_comment_count: 1
    });
    expect(staleErr?.code).toBe("23503");
    expect(staleErr?.hint).toBe("rubric_checks_in_use");

    // Re-preview and confirm with updated count succeeds
    const { data: preview2Raw } = await instructorClient.rpc("preview_rubric_check_deletions", {
      p_rubric_id: rubricId,
      p_removed_check_ids: [checkToctouId]
    });
    const preview2 = parseRubricCheckDeletionPreview(preview2Raw);
    expect(preview2.checks[0].comment_count).toBe(2);

    const { error: okErr } = await instructorClient.rpc("update_rubric_full_with_report", {
      p_rubric: payload as never,
      p_confirm_delete_check_ids: [checkToctouId],
      p_previewed_at: preview2.previewed_at,
      p_expected_active_comment_count: 2
    });
    expect(okErr).toBeNull();
  });

  test("backwards-compatible update_rubric_full(p_rubric) still returns text summary", async () => {
    const instructorClient = await createAuthenticatedClient(instructor);
    const payload = await buildRubricPayloadFromDb(rubricId);
    const { data, error } = await instructorClient.rpc("update_rubric_full", {
      p_rubric: payload as never
    });
    expect(error).toBeNull();
    expect(typeof data).toBe("string");
  });
});

test.describe("Rubric check deletion workflow (UI)", () => {
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;
  let grader: TestingUser;
  let student: TestingUser;
  let assignment: Awaited<ReturnType<typeof insertAssignment>>;
  let softOnlyCheckId: number;
  let appliedCheckId: number;
  let appliedCommentId: number;
  let submissionId: number;
  let gradingReviewId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: "E2E Rubric Check Delete UI" });
    instructor = await createUserInClass({
      name: "UI Delete Instructor",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    });
    grader = await createUserInClass({
      name: "Dana UI Grader",
      role: "grader",
      class_id: course.id
    });
    student = await createUserInClass({
      name: "Alex UI Student",
      role: "student",
      class_id: course.id
    });

    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 7).toISOString(),
      name: "Check Delete UI Assignment"
    });
    const rubricId = assignment.grading_rubric_id!;

    const { data: part, error: pErr } = await supabase
      .from("rubric_parts")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        rubric_id: rubricId,
        name: "UI Workflow Part",
        ordinal: 99
      })
      .select("id")
      .single();
    expect(pErr).toBeNull();

    const { data: crit, error: cErr } = await supabase
      .from("rubric_criteria")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        rubric_id: rubricId,
        rubric_part_id: part!.id,
        name: "UI Workflow Criterion",
        ordinal: 0,
        is_additive: true,
        total_points: 10
      })
      .select("id")
      .single();
    expect(cErr).toBeNull();

    const { data: c1 } = await supabase
      .from("rubric_checks")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        rubric_id: rubricId,
        rubric_criteria_id: crit!.id,
        name: "Self-Deleted Comment Check",
        points: 3,
        ordinal: 0,
        is_annotation: false,
        is_comment_required: false,
        is_required: false,
        student_visibility: "always"
      })
      .select("id")
      .single();
    softOnlyCheckId = c1!.id;

    const { data: c2 } = await supabase
      .from("rubric_checks")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        rubric_id: rubricId,
        rubric_criteria_id: crit!.id,
        name: "Applied Check To Remove",
        points: 7,
        ordinal: 1,
        is_annotation: false,
        is_comment_required: false,
        is_required: false,
        student_visibility: "always"
      })
      .select("id")
      .single();
    appliedCheckId = c2!.id;

    const { error: c3Err } = await supabase.from("rubric_checks").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      rubric_id: rubricId,
      rubric_criteria_id: crit!.id,
      name: "Kept Baseline Check",
      points: 1,
      ordinal: 2,
      is_annotation: false,
      is_comment_required: false,
      is_required: false,
      student_visibility: "always"
    });
    expect(c3Err).toBeNull();

    const sub = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    submissionId = sub.submission_id;
    gradingReviewId = sub.grading_review_id;

    await supabase.from("submission_reviews").update({ released: true }).eq("id", gradingReviewId);

    // Soft-deleted-only comment on softOnlyCheckId
    await supabase.from("submission_comments").insert({
      class_id: course.id,
      submission_id: submissionId,
      submission_review_id: gradingReviewId,
      rubric_check_id: softOnlyCheckId,
      author: grader.private_profile_id,
      comment: "Removed earlier",
      points: 3,
      released: true,
      deleted_at: new Date().toISOString()
    });

    // Active comment (pseudonymous public profile) on appliedCheckId
    const { data: activeRow, error: aErr } = await supabase
      .from("submission_comments")
      .insert({
        class_id: course.id,
        submission_id: submissionId,
        submission_review_id: gradingReviewId,
        rubric_check_id: appliedCheckId,
        author: grader.public_profile_id,
        comment: "Applied grading feedback",
        points: 7,
        released: true
      })
      .select("id")
      .single();
    expect(aErr).toBeNull();
    appliedCommentId = activeRow!.id;
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([instructor]);
  });

  test("soft-deleted-only check deletes cleanly; applied check prompts confirmation, supports cancel, confirms with follow-up report and reopenable banner", async ({
    page
  }) => {
    test.setTimeout(120_000);
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignment.id}/rubric`);

    const editor = rubricEditor(page);
    await expect(editor).toBeVisible({ timeout: 30000 });
    // 1. Delete check that has ONLY a soft-deleted comment -> should save cleanly with NO confirmation modal
    const softCheckRegion = editor.getByRole("region", { name: "Check: Self-Deleted Comment Check" });
    await expect(softCheckRegion).toBeVisible({ timeout: 20000 });
    await softCheckRegion.getByRole("button", { name: "Delete check" }).click();

    await editor.getByRole("button", { name: "Save" }).click();

    // Verify softOnlyCheckId is deleted cleanly from DB with NO confirmation modal,
    // and wait for post-save refetch/sync to complete (Save button returns to disabled).
    await expect
      .poll(
        async () => {
          const { data } = await supabase.from("rubric_checks").select("id").eq("id", softOnlyCheckId).maybeSingle();
          return data;
        },
        { timeout: 15000 }
      )
      .toBeNull();
    await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled({ timeout: 15000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 2. Delete applied check -> click Save -> Confirmation modal opens
    const appliedCheckRegion = editor.getByRole("region", { name: "Check: Applied Check To Remove" });
    await expect(appliedCheckRegion).toBeVisible();
    await appliedCheckRegion.getByRole("button", { name: "Delete check" }).click();
    await expect(editor.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 10000 });

    await editor.getByRole("button", { name: "Save" }).click();

    const confirmDialog = page.getByRole("dialog", { name: /Delete Applied Rubric Check/i });
    await expect(confirmDialog).toBeVisible({ timeout: 15000 });

    // Shows real grader name, email, student submission link with target="_blank", and released warning
    await expect(confirmDialog.getByText("Dana UI Grader")).toBeVisible();
    await expect(confirmDialog.getByText(grader.email)).toBeVisible();
    await expect(confirmDialog.getByText(/already-released grades/i)).toBeVisible();

    const submissionLink = confirmDialog.getByRole("link", { name: /Alex UI Student/i });
    await expect(submissionLink).toBeVisible();
    await expect(submissionLink).toHaveAttribute(
      "href",
      `/course/${course.id}/assignments/${assignment.id}/submissions/${submissionId}`
    );
    await expect(submissionLink).toHaveAttribute("target", "_blank");

    // 3. Cancel keeps everything intact in DB
    await confirmDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmDialog).toBeHidden();

    const { data: stillThere } = await supabase
      .from("rubric_checks")
      .select("id")
      .eq("id", appliedCheckId)
      .maybeSingle();
    expect(stillThere?.id).toBe(appliedCheckId);

    const { data: reviewBefore } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", gradingReviewId)
      .single();

    // 4. Save again and Confirm deletion
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(confirmDialog).toBeVisible({ timeout: 15000 });
    await confirmDialog.getByRole("button", { name: /Delete Checks & Comments and Save/i }).click();

    // Follow-Up Report dialog opens automatically
    const reportDialog = page.getByRole("dialog", { name: /Rubric Saved — Follow-Up Report/i });
    await expect(reportDialog).toBeVisible({ timeout: 20000 });
    await expect(reportDialog.getByText("Dana UI Grader")).toBeVisible();
    await expect(reportDialog.getByRole("button", { name: /Copy follow-up message/i })).toBeVisible();
    await expect(reportDialog.getByRole("button", { name: /Download CSV/i })).toBeVisible();
    await expect(reportDialog.getByRole("button", { name: /Copy Report \(Markdown\)/i })).toBeVisible();

    // Switch to By Rubric Check tab
    await reportDialog.getByRole("button", { name: /By Rubric Check/i }).click();
    await expect(reportDialog.getByText("Applied Check To Remove")).toBeVisible();

    // Close report dialog -> reopenable banner appears
    await reportDialog.getByRole("button", { name: "Done" }).click();
    await expect(reportDialog).toBeHidden();

    const viewReportBtn = editor.getByRole("button", { name: "View Follow-Up Report" });
    await expect(viewReportBtn).toBeVisible();
    await viewReportBtn.click();
    await expect(reportDialog).toBeVisible();
    await reportDialog.getByRole("button", { name: "Done" }).click();

    // Verify DB state: check deleted, comment soft-deleted & detached, score recomputed to 0
    const { data: deletedCheck } = await supabase
      .from("rubric_checks")
      .select("id")
      .eq("id", appliedCheckId)
      .maybeSingle();
    expect(deletedCheck).toBeNull();

    const { data: deletedComment } = await supabase
      .from("submission_comments")
      .select("deleted_at, rubric_check_id, edited_by")
      .eq("id", appliedCommentId)
      .single();
    expect(deletedComment?.deleted_at).not.toBeNull();
    expect(deletedComment?.rubric_check_id).toBeNull();
    expect(deletedComment?.edited_by).toBe(instructor.private_profile_id);

    const { data: reviewAfter } = await supabase
      .from("submission_reviews")
      .select("total_score")
      .eq("id", gradingReviewId)
      .single();
    expect(reviewAfter?.total_score).toBe(reviewBefore!.total_score - 7);
  });
});
