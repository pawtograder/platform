import {
  isReviewComplete,
  selectAssignableSubmissions,
  type AssignableSubmissionRow
} from "@/supabase/functions/cli/utils/reviewStatus";

describe("isReviewComplete", () => {
  const assignee = "profile-a";

  it("is complete when the assignment itself is completed", () => {
    expect(
      isReviewComplete({
        completed_at: "2026-03-01T00:00:00Z",
        assignee_profile_id: assignee,
        submission_reviews: null
      })
    ).toBe(true);
  });

  it("is complete when the linked review was completed by this assignee", () => {
    // The database does not write assignment completion back from the review, so this
    // is the case the CLI used to report as pending while the web showed it done.
    expect(
      isReviewComplete({
        completed_at: null,
        assignee_profile_id: assignee,
        submission_reviews: { completed_at: "2026-03-01T00:00:00Z", grader: assignee }
      })
    ).toBe(true);
  });

  it("is pending when the linked review was completed by a different grader", () => {
    // Under by-part grading several assignees share one submission_review; only the
    // grader named on it finished anything.
    expect(
      isReviewComplete({
        completed_at: null,
        assignee_profile_id: assignee,
        submission_reviews: { completed_at: "2026-03-01T00:00:00Z", grader: "profile-b" }
      })
    ).toBe(false);
  });

  it("is pending when the linked review exists but is unfinished", () => {
    expect(
      isReviewComplete({
        completed_at: null,
        assignee_profile_id: assignee,
        submission_reviews: { completed_at: null, grader: assignee }
      })
    ).toBe(false);
  });

  it("is pending with no linked review at all", () => {
    expect(isReviewComplete({ completed_at: null, assignee_profile_id: assignee })).toBe(false);
    expect(isReviewComplete({ completed_at: null, assignee_profile_id: assignee, submission_reviews: null })).toBe(
      false
    );
  });
});

describe("selectAssignableSubmissions", () => {
  const rows: AssignableSubmissionRow[] = [
    { id: 1, profile_id: "active-1", assignment_group_id: null, submitted_via: "github" },
    { id: 2, profile_id: "active-2", assignment_group_id: null, submitted_via: "manual" },
    { id: 3, profile_id: "dropped", assignment_group_id: null, submitted_via: "github" },
    { id: 4, profile_id: null, assignment_group_id: 10, submitted_via: "github" },
    { id: 5, profile_id: null, assignment_group_id: 11, submitted_via: "github" }
  ];
  const activeProfiles = new Set(["active-1", "active-2", "group-active"]);
  const groupMembers = new Map<number, string[]>([
    [10, ["group-active", "dropped"]],
    [11, ["dropped", "also-dropped"]]
  ]);

  it("drops manual stubs and submissions with no enrolled owner", () => {
    const result = selectAssignableSubmissions({ submissions: rows, activeProfiles, groupMembers, excludeStubs: true });
    expect(result.submissions.map((s) => s.id)).toEqual([1, 4]);
    expect(result.excluded).toEqual({ stubs: 1, dropped_students: 2 });
  });

  it("keeps manual stubs when they are not excluded", () => {
    // --include-non-submitters, and no_submission assignments where stubs are all there is.
    const result = selectAssignableSubmissions({
      submissions: rows,
      activeProfiles,
      groupMembers,
      excludeStubs: false
    });
    expect(result.submissions.map((s) => s.id)).toEqual([1, 2, 4]);
    expect(result.excluded).toEqual({ stubs: 0, dropped_students: 2 });
  });

  it("keeps a group submission when any one member is still enrolled", () => {
    const result = selectAssignableSubmissions({
      submissions: [rows[3]],
      activeProfiles,
      groupMembers,
      excludeStubs: true
    });
    expect(result.submissions.map((s) => s.id)).toEqual([4]);
  });

  it("drops a group submission whose group has no members loaded", () => {
    const result = selectAssignableSubmissions({
      submissions: [{ id: 9, profile_id: null, assignment_group_id: 99, submitted_via: "github" }],
      activeProfiles,
      groupMembers,
      excludeStubs: true
    });
    expect(result.submissions).toEqual([]);
    expect(result.excluded.dropped_students).toBe(1);
  });

  it("counts a stub only once, as a stub, when its owner also dropped", () => {
    const result = selectAssignableSubmissions({
      submissions: [{ id: 8, profile_id: "dropped", assignment_group_id: null, submitted_via: "manual" }],
      activeProfiles,
      groupMembers,
      excludeStubs: true
    });
    expect(result.excluded).toEqual({ stubs: 1, dropped_students: 0 });
  });
});
