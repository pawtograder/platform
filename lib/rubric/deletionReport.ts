import type { HydratedRubric } from "@/utils/supabase/DatabaseTypes";
import Papa from "papaparse";

export type RubricCheckCommentType = "submission" | "file" | "artifact";

export type RubricCheckCommentApplication = {
  submission_id: number;
  submission_ordinal: number | null;
  is_active: boolean;
  student_or_group_name: string;
  is_group: boolean;
  submission_review_id: number | null;
  review_released: boolean;
  grader_profile_id: string | null;
  grader_name: string;
  grader_email: string | null;
  comment_id: number;
  comment_type: RubricCheckCommentType;
  file_name: string | null;
  line: number | null;
  artifact_name: string | null;
  points: number | null;
  comment_text: string;
  created_at: string;
};

export type RubricCheckBareRegradeRequest = {
  regrade_request_id: number;
  submission_id: number;
  submission_ordinal: number | null;
  student_or_group_name: string;
  status: string;
  assignee_profile_id: string | null;
  assignee_name: string;
  assignee_email: string | null;
};

export type RubricCheckDeletionImpact = {
  check_id: number;
  check_name: string;
  check_points: number | null;
  criterion_id: number;
  criterion_name: string;
  part_id: number;
  part_name: string;
  submission_count: number;
  comment_count: number;
  released_submission_count: number;
  active_regrade_request_count: number;
  bare_regrade_request_count: number;
  applications: RubricCheckCommentApplication[];
  bare_regrade_requests: RubricCheckBareRegradeRequest[];
};

export type RubricCheckDeletionPreview = {
  previewed_at: string;
  checks: RubricCheckDeletionImpact[];
};

export type DeletedRubricChecksReport = {
  deleted_at: string;
  rubric_id: number;
  rubric_name: string;
  checks: RubricCheckDeletionImpact[];
};

export type RubricSaveWithReportResponse = {
  summary: string;
  deleted_checks_report: DeletedRubricChecksReport | null;
};

export type DeletionImpactTotals = {
  checkCount: number;
  distinctSubmissionCount: number;
  commentCount: number;
  releasedSubmissionCount: number;
  activeRegradeCount: number;
  bareRegradeCount: number;
  distinctGraderCount: number;
};

export type GraderFollowUpItem = {
  check_id: number;
  check_name: string;
  criterion_name: string;
  part_name: string;
  check_points: number | null;
  submission_id: number;
  submission_ordinal: number | null;
  is_active: boolean;
  student_or_group_name: string;
  review_released: boolean;
  comment_id: number;
  comment_type: RubricCheckCommentType;
  file_name: string | null;
  line: number | null;
  artifact_name: string | null;
  points: number | null;
  comment_text: string;
};

export type GraderFollowUpGroup = {
  graderKey: string;
  grader_profile_id: string | null;
  grader_name: string;
  grader_email: string | null;
  distinctSubmissionCount: number;
  commentCount: number;
  releasedSubmissionCount: number;
  checkNames: string[];
  items: GraderFollowUpItem[];
};

/**
 * Returns existing positive DB rubric_check IDs present on `existingRubric` that are absent from
 * `nextRubric`. Catches direct check deletions, deleted criteria/parts, and YAML replacements.
 */
export function findRemovedRubricCheckIds(
  existingRubric: HydratedRubric | undefined,
  nextRubric: HydratedRubric
): number[] {
  if (!existingRubric || existingRubric.id <= 0) return [];

  const nextCheckIds = new Set<number>();
  for (const part of nextRubric.rubric_parts) {
    for (const crit of part.rubric_criteria) {
      for (const check of crit.rubric_checks) {
        if (check.id > 0) nextCheckIds.add(check.id);
      }
    }
  }

  const removed: number[] = [];
  const seen = new Set<number>();
  for (const part of existingRubric.rubric_parts) {
    for (const crit of part.rubric_criteria) {
      for (const check of crit.rubric_checks) {
        if (check.id > 0 && !nextCheckIds.has(check.id) && !seen.has(check.id)) {
          seen.add(check.id);
          removed.push(check.id);
        }
      }
    }
  }
  return removed;
}

export function computeDeletionTotals(checks: RubricCheckDeletionImpact[]): DeletionImpactTotals {
  const submissionIds = new Set<number>();
  const releasedSubmissionIds = new Set<number>();
  const graderKeys = new Set<string>();
  let commentCount = 0;
  let activeRegradeCount = 0;
  let bareRegradeCount = 0;

  for (const check of checks) {
    commentCount += check.comment_count;
    activeRegradeCount += check.active_regrade_request_count;
    bareRegradeCount += check.bare_regrade_request_count;
    for (const app of check.applications) {
      submissionIds.add(app.submission_id);
      if (app.review_released) releasedSubmissionIds.add(app.submission_id);
      graderKeys.add(app.grader_profile_id ?? app.grader_name);
    }
    for (const req of check.bare_regrade_requests) {
      submissionIds.add(req.submission_id);
    }
  }

  return {
    checkCount: checks.length,
    distinctSubmissionCount: submissionIds.size,
    commentCount,
    releasedSubmissionCount: releasedSubmissionIds.size,
    activeRegradeCount,
    bareRegradeCount,
    distinctGraderCount: graderKeys.size
  };
}

export function groupDeletionsByGrader(checks: RubricCheckDeletionImpact[]): GraderFollowUpGroup[] {
  const byGrader = new Map<
    string,
    {
      grader_profile_id: string | null;
      grader_name: string;
      grader_email: string | null;
      submissionIds: Set<number>;
      releasedSubmissionIds: Set<number>;
      checkNames: Set<string>;
      items: GraderFollowUpItem[];
    }
  >();

  for (const check of checks) {
    for (const app of check.applications) {
      const key = app.grader_profile_id ?? `name:${app.grader_name}`;
      let entry = byGrader.get(key);
      if (!entry) {
        entry = {
          grader_profile_id: app.grader_profile_id,
          grader_name: app.grader_name,
          grader_email: app.grader_email,
          submissionIds: new Set(),
          releasedSubmissionIds: new Set(),
          checkNames: new Set(),
          items: []
        };
        byGrader.set(key, entry);
      }
      entry.submissionIds.add(app.submission_id);
      if (app.review_released) entry.releasedSubmissionIds.add(app.submission_id);
      entry.checkNames.add(check.check_name);
      entry.items.push({
        check_id: check.check_id,
        check_name: check.check_name,
        criterion_name: check.criterion_name,
        part_name: check.part_name,
        check_points: check.check_points,
        submission_id: app.submission_id,
        submission_ordinal: app.submission_ordinal,
        is_active: app.is_active,
        student_or_group_name: app.student_or_group_name,
        review_released: app.review_released,
        comment_id: app.comment_id,
        comment_type: app.comment_type,
        file_name: app.file_name,
        line: app.line,
        artifact_name: app.artifact_name,
        points: app.points,
        comment_text: app.comment_text
      });
    }
  }

  return Array.from(byGrader.entries())
    .map(([graderKey, entry]) => ({
      graderKey,
      grader_profile_id: entry.grader_profile_id,
      grader_name: entry.grader_name,
      grader_email: entry.grader_email,
      distinctSubmissionCount: entry.submissionIds.size,
      commentCount: entry.items.length,
      releasedSubmissionCount: entry.releasedSubmissionIds.size,
      checkNames: Array.from(entry.checkNames),
      items: entry.items
    }))
    .sort(
      (a, b) => b.distinctSubmissionCount - a.distinctSubmissionCount || a.grader_name.localeCompare(b.grader_name)
    );
}

export function buildSubmissionHref(
  courseId: number | string,
  assignmentId: number | string,
  submissionId: number,
  origin?: string
): string {
  const path = `/course/${courseId}/assignments/${assignmentId}/submissions/${submissionId}`;
  if (!origin) return path;
  return `${origin.replace(/\/$/, "")}${path}`;
}

export function formatCommentLocation(
  app: Pick<RubricCheckCommentApplication, "comment_type" | "file_name" | "line" | "artifact_name">
): string {
  if (app.comment_type === "file") {
    const fileLabel = app.file_name || "file";
    return app.line != null ? `${fileLabel}:${app.line}` : fileLabel;
  }
  if (app.comment_type === "artifact") {
    return app.artifact_name ? `Artifact: ${app.artifact_name}` : "Artifact comment";
  }
  return "Submission comment";
}

export function formatGraderFollowUpMessage(
  group: GraderFollowUpGroup,
  context: {
    assignmentTitle?: string;
    rubricName: string;
    courseId: number | string;
    assignmentId: number | string;
    origin?: string;
  }
): string {
  const heading = context.assignmentTitle ? `${context.assignmentTitle} (${context.rubricName})` : context.rubricName;
  const lines: string[] = [
    `Hi ${group.grader_name},`,
    "",
    `The following rubric check(s) were removed from "${heading}", which removed ${group.commentCount} grading comment(s) you previously applied across ${group.distinctSubmissionCount} submission(s). Please review these submissions and update grading as needed:`,
    ""
  ];

  // Group items by submission so the grader sees one clean bullet per submission.
  const bySubmission = new Map<number, GraderFollowUpItem[]>();
  for (const item of group.items) {
    const list = bySubmission.get(item.submission_id) ?? [];
    list.push(item);
    bySubmission.set(item.submission_id, list);
  }

  for (const [submissionId, items] of bySubmission.entries()) {
    const first = items[0];
    const url = buildSubmissionHref(context.courseId, context.assignmentId, submissionId, context.origin);
    const ordinal = first.submission_ordinal != null ? ` (#${first.submission_ordinal})` : "";
    const releasedTag = first.review_released ? " [Released]" : "";
    const checkSummary = items
      .map((item) => {
        const pts = item.points != null ? ` (${item.points} pts)` : "";
        return `${item.check_name}${pts}`;
      })
      .join(", ");
    lines.push(`- ${first.student_or_group_name}${ordinal}${releasedTag} — ${checkSummary}`);
    lines.push(`  ${url}`);
  }

  return lines.join("\n");
}

export function formatFullDeletionReportMarkdown(
  report: DeletedRubricChecksReport,
  context: {
    assignmentTitle?: string;
    courseId: number | string;
    assignmentId: number | string;
    origin?: string;
  }
): string {
  const totals = computeDeletionTotals(report.checks);
  const byGrader = groupDeletionsByGrader(report.checks);
  const title = context.assignmentTitle ? `${context.assignmentTitle} — ${report.rubric_name}` : report.rubric_name;

  const lines: string[] = [
    `# Deleted Rubric Checks Follow-Up Report`,
    ``,
    `- **Rubric:** ${title}`,
    `- **Deleted at:** ${report.deleted_at}`,
    `- **Summary:** ${totals.checkCount} rubric check(s) deleted, ${totals.commentCount} comment(s) removed across ${totals.distinctSubmissionCount} submission(s) (${totals.distinctGraderCount} grader(s)).`,
    ``
  ];

  if (totals.releasedSubmissionCount > 0) {
    lines.push(`> Note: ${totals.releasedSubmissionCount} affected submission(s) had already-released grades.`);
    lines.push(``);
  }

  lines.push(`## Follow-Up by Grader`, ``);
  for (const group of byGrader) {
    const emailPart = group.grader_email ? ` <${group.grader_email}>` : "";
    lines.push(
      `### ${group.grader_name}${emailPart} (${group.distinctSubmissionCount} submission(s), ${group.commentCount} comment(s))`
    );
    lines.push(``);
    for (const item of group.items) {
      const url = buildSubmissionHref(context.courseId, context.assignmentId, item.submission_id, context.origin);
      const ordinal = item.submission_ordinal != null ? ` #${item.submission_ordinal}` : "";
      const releasedTag = item.review_released ? " **[Released]**" : "";
      const pts = item.points != null ? ` (${item.points} pts)` : "";
      const location = formatCommentLocation(item);
      lines.push(
        `- [${item.student_or_group_name}${ordinal}](${url})${releasedTag} — **${item.check_name}**${pts} · ${location}`
      );
    }
    lines.push(``);
  }

  lines.push(`## Deleted Rubric Checks`, ``);
  for (const check of report.checks) {
    lines.push(
      `- **${check.part_name} › ${check.criterion_name} › ${check.check_name}** (${check.check_points ?? 0} pts): ${check.submission_count} submission(s), ${check.comment_count} comment(s)`
    );
  }

  const allBareRegrades = report.checks.flatMap((check) => check.bare_regrade_requests.map((req) => ({ check, req })));
  if (allBareRegrades.length > 0) {
    lines.push(``, `## Affected Un-Applied Check Regrade Requests`, ``);
    for (const { check, req } of allBareRegrades) {
      const url = buildSubmissionHref(context.courseId, context.assignmentId, req.submission_id, context.origin);
      lines.push(
        `- [${req.student_or_group_name}](${url}) — **${check.check_name}** (status was \`${req.status}\`, assignee: ${req.assignee_name})`
      );
    }
  }

  return lines.join("\n");
}

export function formatDeletedChecksCsv(
  report: DeletedRubricChecksReport,
  context: {
    courseId: number | string;
    assignmentId: number | string;
    origin?: string;
  }
): string {
  const rows: Record<string, string | number | boolean>[] = [];

  for (const check of report.checks) {
    for (const app of check.applications) {
      rows.push({
        deleted_at: report.deleted_at,
        rubric_name: report.rubric_name,
        part_name: check.part_name,
        criterion_name: check.criterion_name,
        rubric_check_name: check.check_name,
        check_points: check.check_points ?? "",
        submission_id: app.submission_id,
        submission_ordinal: app.submission_ordinal ?? "",
        is_active_submission: app.is_active,
        student_or_group: app.student_or_group_name,
        review_released: app.review_released,
        grader_name: app.grader_name,
        grader_email: app.grader_email ?? "",
        comment_type: app.comment_type,
        location: formatCommentLocation(app),
        comment_points: app.points ?? "",
        comment_text: app.comment_text,
        submission_url: buildSubmissionHref(context.courseId, context.assignmentId, app.submission_id, context.origin)
      });
    }
  }

  return Papa.unparse(rows);
}

export function parseRubricCheckDeletionPreview(raw: unknown): RubricCheckDeletionPreview {
  if (!raw || typeof raw !== "object") {
    return { previewed_at: new Date().toISOString(), checks: [] };
  }
  const obj = raw as { previewed_at?: unknown; checks?: unknown };
  return {
    previewed_at: typeof obj.previewed_at === "string" ? obj.previewed_at : new Date().toISOString(),
    checks: Array.isArray(obj.checks) ? (obj.checks as RubricCheckDeletionImpact[]) : []
  };
}

export function parseDeletedRubricChecksReport(raw: unknown): DeletedRubricChecksReport | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    deleted_at?: unknown;
    rubric_id?: unknown;
    rubric_name?: unknown;
    checks?: unknown;
  };
  const checks = Array.isArray(obj.checks) ? (obj.checks as RubricCheckDeletionImpact[]) : [];
  if (checks.length === 0) return null;
  return {
    deleted_at: typeof obj.deleted_at === "string" ? obj.deleted_at : new Date().toISOString(),
    rubric_id: typeof obj.rubric_id === "number" ? obj.rubric_id : Number(obj.rubric_id ?? 0),
    rubric_name: typeof obj.rubric_name === "string" ? obj.rubric_name : "Rubric",
    checks
  };
}
