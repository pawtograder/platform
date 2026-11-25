import {
  buildSubmissionHref,
  computeDeletionTotals,
  extractActiveItemKeys,
  findRemovedRubricCheckIds,
  formatCommentLocation,
  formatDeletedChecksCsv,
  formatFullDeletionReportMarkdown,
  formatGraderFollowUpMessage,
  groupDeletionsByGrader,
  parseDeletedRubricChecksReport,
  parseRubricCheckDeletionPreview,
  type DeletedRubricChecksReport,
  type RubricCheckDeletionImpact
} from "@/lib/rubric/deletionReport";
import type { HydratedRubric } from "@/utils/supabase/DatabaseTypes";

function makeRubric(checkIdsByPart: number[][][]): HydratedRubric {
  return {
    id: 42,
    class_id: 2,
    assignment_id: 9,
    name: "HW1 Grading Rubric",
    description: null,
    is_private: false,
    review_round: "grading-review",
    created_at: "2026-01-01T00:00:00Z",
    cap_score_to_assignment_points: false,
    hide_unless_assigned: false,
    rubric_parts: checkIdsByPart.map((criteriaList, pIdx) => ({
      id: pIdx + 1,
      class_id: 2,
      assignment_id: 9,
      rubric_id: 42,
      exam_question_id: null,
      name: `Part ${pIdx + 1}`,
      description: null,
      ordinal: pIdx,
      data: null,
      created_at: "2026-01-01T00:00:00Z",
      is_individual_grading: false,
      is_assign_to_student: false,
      rubric_criteria: criteriaList.map((checkIds, cIdx) => ({
        id: pIdx * 10 + cIdx + 1,
        class_id: 2,
        assignment_id: 9,
        rubric_id: 42,
        rubric_part_id: pIdx + 1,
        exam_question_id: null,
        name: `Criterion ${cIdx + 1}`,
        description: null,
        ordinal: cIdx,
        data: null,
        created_at: "2026-01-01T00:00:00Z",
        is_additive: true,
        is_deduction_only: false,
        total_points: 10,
        max_checks_per_submission: null,
        min_checks_per_submission: null,
        rubric_checks: checkIds.map((id, kIdx) => ({
          id,
          class_id: 2,
          assignment_id: 9,
          rubric_id: 42,
          rubric_criteria_id: pIdx * 10 + cIdx + 1,
          exam_question_id: null,
          name: `Check ${id}`,
          description: null,
          ordinal: kIdx,
          data: null,
          created_at: "2026-01-01T00:00:00Z",
          file: null,
          artifact: null,
          group: null,
          is_annotation: false,
          is_comment_required: false,
          is_required: false,
          max_annotations: null,
          points: 5,
          annotation_target: null,
          student_visibility: "always",
          kpi_category: null
        }))
      }))
    }))
  };
}

const sampleImpactChecks: RubricCheckDeletionImpact[] = [
  {
    check_id: 101,
    check_name: "Missing unit tests",
    check_points: 5,
    criterion_id: 10,
    criterion_name: "Testing",
    part_id: 1,
    part_name: "Part 1",
    submission_count: 2,
    comment_count: 2,
    released_submission_count: 1,
    active_regrade_request_count: 1,
    bare_regrade_request_count: 0,
    applications: [
      {
        submission_id: 500,
        submission_ordinal: 3,
        is_active: true,
        student_or_group_name: "Alice Student",
        is_group: false,
        submission_review_id: 900,
        review_released: true,
        grader_profile_id: "grader-1",
        grader_name: "Grace Grader",
        grader_email: "grace@example.edu",
        comment_id: 701,
        comment_type: "file",
        file_name: "src/App.ts",
        line: 42,
        artifact_name: null,
        points: 5,
        comment_text: "Add edge case tests",
        created_at: "2026-11-25T10:00:00Z"
      },
      {
        submission_id: 501,
        submission_ordinal: 1,
        is_active: true,
        student_or_group_name: "Team Rockets",
        is_group: true,
        submission_review_id: 901,
        review_released: false,
        grader_profile_id: "grader-2",
        grader_name: "Pat TA",
        grader_email: "pat@example.edu",
        comment_id: 702,
        comment_type: "submission",
        file_name: null,
        line: null,
        artifact_name: null,
        points: 3,
        comment_text: "Partial test coverage",
        created_at: "2026-11-25T10:05:00Z"
      }
    ],
    bare_regrade_requests: []
  },
  {
    check_id: 102,
    check_name: "PDF diagram unclear",
    check_points: 2,
    criterion_id: 11,
    criterion_name: "Documentation",
    part_id: 1,
    part_name: "Part 1",
    submission_count: 2,
    comment_count: 1,
    released_submission_count: 1,
    active_regrade_request_count: 0,
    bare_regrade_request_count: 1,
    applications: [
      {
        submission_id: 500,
        submission_ordinal: 3,
        is_active: true,
        student_or_group_name: "Alice Student",
        is_group: false,
        submission_review_id: 900,
        review_released: true,
        grader_profile_id: "grader-1",
        grader_name: "Grace Grader",
        grader_email: "grace@example.edu",
        comment_id: 703,
        comment_type: "artifact",
        file_name: null,
        line: null,
        artifact_name: "design.pdf",
        points: 2,
        comment_text: "Blurry diagram",
        created_at: "2026-11-25T10:10:00Z"
      }
    ],
    bare_regrade_requests: [
      {
        regrade_request_id: 88,
        submission_id: 502,
        submission_ordinal: 2,
        student_or_group_name: "Bob Student",
        status: "opened",
        assignee_profile_id: "grader-2",
        assignee_name: "Pat TA",
        assignee_email: "pat@example.edu"
      }
    ]
  }
];

describe("lib/rubric/deletionReport", () => {
  describe("findRemovedRubricCheckIds", () => {
    it("returns empty array when there is no existing persisted rubric", () => {
      const next = makeRubric([[[101]]]);
      expect(findRemovedRubricCheckIds(undefined, next)).toEqual([]);
      const unsaved = { ...makeRubric([[[101]]]), id: 0 };
      expect(findRemovedRubricCheckIds(unsaved, next)).toEqual([]);
    });

    it("detects directly deleted checks, deleted criteria, deleted parts, and ignores negative unsaved IDs", () => {
      const existing = makeRubric([
        [
          [101, 102, -5],
          [103, 104]
        ],
        [[201]]
      ]);
      // Keep 101, drop 102 directly, drop entire 2nd criterion (103, 104), drop entire 2nd part (201), add new check -1
      const next = makeRubric([[[101, -1]]]);
      expect(findRemovedRubricCheckIds(existing, next)).toEqual([102, 103, 104, 201]);
    });

    it("detects all checks removed when replaced by a demo template (negative IDs only)", () => {
      const existing = makeRubric([[[10, 11]]]);
      const demo = makeRubric([[[-1, -2]]]);
      expect(findRemovedRubricCheckIds(existing, demo)).toEqual([10, 11]);
    });
  });

  describe("extractActiveItemKeys", () => {
    it("derives sorted unique keys across all comment types and bare regrade requests", () => {
      const keys = extractActiveItemKeys({
        previewed_at: "2026-11-25T18:00:00Z",
        checks: sampleImpactChecks
      });
      expect(keys).toEqual(["artifact:703", "bare_regrade:88", "file:701", "submission:702"]);
    });

    it("prefers server-supplied active_item_keys when present", () => {
      const parsed = parseRubricCheckDeletionPreview({
        previewed_at: "2026-11-25T18:00:00Z",
        checks: sampleImpactChecks,
        active_item_keys: ["submission:702", "file:701", "submission:702"]
      });
      expect(extractActiveItemKeys(parsed)).toEqual(["file:701", "submission:702"]);
    });
  });

  describe("computeDeletionTotals", () => {
    it("deduplicates submissions, released submissions, and graders across multiple checks", () => {
      const totals = computeDeletionTotals(sampleImpactChecks);
      expect(totals).toEqual({
        checkCount: 2,
        distinctSubmissionCount: 3, // 500, 501, and bare regrade 502
        commentCount: 3,
        releasedSubmissionCount: 1, // 500 counted once across both checks
        activeRegradeCount: 1,
        bareRegradeCount: 1,
        distinctGraderCount: 2 // grader-1 and grader-2
      });
    });
  });

  describe("groupDeletionsByGrader", () => {
    it("groups comments by grader with distinct submission counts and sorts deterministically", () => {
      const groups = groupDeletionsByGrader(sampleImpactChecks);
      expect(groups).toHaveLength(2);
      expect(groups[0]).toMatchObject({
        grader_profile_id: "grader-1",
        grader_name: "Grace Grader",
        grader_email: "grace@example.edu",
        distinctSubmissionCount: 1,
        commentCount: 2,
        releasedSubmissionCount: 1,
        checkNames: ["Missing unit tests", "PDF diagram unclear"]
      });
      expect(groups[1]).toMatchObject({
        grader_profile_id: "grader-2",
        grader_name: "Pat TA",
        distinctSubmissionCount: 1,
        commentCount: 1,
        releasedSubmissionCount: 0
      });
    });
  });

  describe("formatting helpers", () => {
    const report: DeletedRubricChecksReport = {
      deleted_at: "2026-11-25T18:00:00Z",
      rubric_id: 42,
      rubric_name: "HW1 Grading Rubric",
      checks: sampleImpactChecks
    };

    it("builds submission URLs with and without origin", () => {
      expect(buildSubmissionHref(2, 9, 500)).toBe("/course/2/assignments/9/submissions/500");
      expect(buildSubmissionHref(2, 9, 500, "https://app.pawtograder.com/")).toBe(
        "https://app.pawtograder.com/course/2/assignments/9/submissions/500"
      );
    });

    it("formats comment locations across file, artifact, and submission comments", () => {
      expect(
        formatCommentLocation({ comment_type: "file", file_name: "src/App.ts", line: 42, artifact_name: null })
      ).toBe("src/App.ts:42");
      expect(
        formatCommentLocation({ comment_type: "file", file_name: "src/App.ts", line: null, artifact_name: null })
      ).toBe("src/App.ts");
      expect(
        formatCommentLocation({ comment_type: "artifact", file_name: null, line: null, artifact_name: "design.pdf" })
      ).toBe("Artifact: design.pdf");
      expect(
        formatCommentLocation({ comment_type: "submission", file_name: null, line: null, artifact_name: null })
      ).toBe("Submission comment");
    });

    it("formats per-grader follow-up message grouping multiple comments on the same submission", () => {
      const [grace] = groupDeletionsByGrader(sampleImpactChecks);
      const msg = formatGraderFollowUpMessage(grace, {
        assignmentTitle: "HW1",
        rubricName: "HW1 Grading Rubric",
        courseId: 2,
        assignmentId: 9,
        origin: "https://app.pawtograder.com"
      });
      expect(msg).toContain("Hi Grace Grader,");
      expect(msg).toContain("2 grading comment(s) you previously applied across 1 submission(s)");
      expect(msg).toContain(
        "Alice Student (#3) [Released] \u2014 Missing unit tests (5 pts), PDF diagram unclear (2 pts)"
      );
      expect(msg).toContain("https://app.pawtograder.com/course/2/assignments/9/submissions/500");
    });

    it("marks a submission [Released] in grader follow-up message when any item on that submission is released", () => {
      const [grace] = groupDeletionsByGrader(sampleImpactChecks);
      const mixedGroup = {
        ...grace,
        items: [
          { ...grace.items[0], review_released: false },
          { ...grace.items[1], review_released: true }
        ]
      };
      const msg = formatGraderFollowUpMessage(mixedGroup, {
        assignmentTitle: "HW1",
        rubricName: "HW1 Grading Rubric",
        courseId: 2,
        assignmentId: 9
      });
      expect(msg).toContain("Alice Student (#3) [Released]");
    });

    it("formats full markdown report including grader sections, checks, and bare regrade requests", () => {
      const md = formatFullDeletionReportMarkdown(report, {
        assignmentTitle: "HW1",
        courseId: 2,
        assignmentId: 9,
        origin: "https://app.pawtograder.com"
      });
      expect(md).toContain("# Deleted Rubric Checks Follow-Up Report");
      expect(md).toContain("1 affected submission(s) had already-released grades");
      expect(md).toContain("### Grace Grader <grace@example.edu>");
      expect(md).toContain("## Affected Un-Applied Check Regrade Requests");
      expect(md).toContain("Bob Student");
    });

    it("formats CSV export with comment and bare regrade rows, full submission URLs, and formula escaping", () => {
      const formulaReport: DeletedRubricChecksReport = {
        ...report,
        checks: [
          {
            ...sampleImpactChecks[0],
            applications: [
              {
                ...sampleImpactChecks[0].applications[0],
                student_or_group_name: "=CMD('calc')",
                file_name: "+evil.ts",
                comment_text: "@SUM(A1:A5)",
                points: -5
              },
              sampleImpactChecks[0].applications[1]
            ]
          },
          sampleImpactChecks[1]
        ]
      };
      const csv = formatDeletedChecksCsv(formulaReport, {
        courseId: 2,
        assignmentId: 9,
        origin: "https://app.pawtograder.com"
      });
      const lines = csv.trim().split(/\r?\n/);
      expect(lines).toHaveLength(5); // header + 3 comment rows + 1 bare regrade row
      expect(lines[0]).toContain("record_type");
      expect(lines[0]).toContain("rubric_check_name");
      expect(lines[0]).toContain("regrade_request_id");
      expect(lines[0]).toContain("submission_url");
      // Formula-prefixed strings are neutralized while numeric negative points remain unescaped numbers
      expect(csv).toContain("'=CMD('calc')");
      expect(csv).toContain("'+evil.ts:42");
      expect(csv).toContain("'@SUM(A1:A5)");
      expect(lines[1]).toContain(",-5,");
      // Bare regrade request row is emitted distinctly
      expect(csv).toContain("bare_regrade_request");
      expect(csv).toContain("Bob Student");
      expect(csv).toContain("https://app.pawtograder.com/course/2/assignments/9/submissions/502");
      expect(csv).toContain("Artifact: design.pdf");
    });

    it("safely parses RPC JSON responses", () => {
      expect(parseRubricCheckDeletionPreview(null).checks).toEqual([]);
      expect(parseDeletedRubricChecksReport(null)).toBeNull();
      expect(parseDeletedRubricChecksReport({ checks: [] })).toBeNull();
      const parsed = parseDeletedRubricChecksReport(report);
      expect(parsed?.checks).toHaveLength(2);
    });
  });
});
