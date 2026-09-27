/**
 * @jest-environment node
 */
import { describeBulkReleaseResult, describeReleaseAllResult } from "@/lib/bulkReleaseMessage";

describe("describeBulkReleaseResult", () => {
  it("reports the RPC count, not the selection size", () => {
    // The bug: selecting 40 and releasing 12 reported "40 selected submission reviews released".
    const msg = describeBulkReleaseResult({ affected: 12, selectedCount: 40, action: "released" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("12 of 40 selected submissions");
    expect(msg.description).toContain("Released the grading review");
  });

  it("treats a full release as success", () => {
    const msg = describeBulkReleaseResult({ affected: 40, selectedCount: 40, action: "released" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("40 of 40 selected submissions");
  });

  it("says which review rounds were left alone", () => {
    // The RPC scopes to submissions.grading_review_id precisely so self-review and meta-grading
    // rounds are not published; the toast has to say so or instructors cannot tell.
    const msg = describeBulkReleaseResult({ affected: 3, selectedCount: 5, action: "released" });
    expect(msg.description).toContain("Self-review and meta-grading rounds were not changed");
  });

  it("uses the unrelease verb for an unrelease", () => {
    const msg = describeBulkReleaseResult({ affected: 2, selectedCount: 2, action: "unreleased" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("Unreleased the grading review for 2 of 2 selected submissions");
  });

  it("warns when nothing changed rather than reporting success", () => {
    const msg = describeBulkReleaseResult({ affected: 0, selectedCount: 40, action: "released" });
    expect(msg.status).toBe("warning");
    expect(msg.title).toBe("Nothing to release");
    expect(msg.description).toContain("already released");
  });

  it("warns for a no-op unrelease with the right wording", () => {
    const msg = describeBulkReleaseResult({ affected: 0, selectedCount: 3, action: "unreleased" });
    expect(msg.status).toBe("warning");
    expect(msg.title).toBe("Nothing to unrelease");
    expect(msg.description).toContain("not released");
  });

  it("uses singular forms for one submission", () => {
    const msg = describeBulkReleaseResult({ affected: 1, selectedCount: 1, action: "released" });
    expect(msg.description).toContain("1 of 1 selected submission.");
    expect(msg.description).not.toContain("selected submissions");
  });

  it("counts submissions, since only one grading review per submission can flip", () => {
    // Pins the post-fix semantics: the RPC joins submission_reviews.id = submissions.grading_review_id,
    // so `affected` can never exceed the (deduped) selection and "N of M submissions" is exact.
    // Before the fix it joined on submission_id alone and a submission carrying a self-review or
    // meta-grading round contributed extra rows, inflating the count past the selection.
    const msg = describeBulkReleaseResult({ affected: 4, selectedCount: 4, action: "released" });
    expect(msg.description).toContain("4 of 4 selected submissions");
    expect(msg.description).not.toContain("submission reviews");
  });
});

describe("describeReleaseAllResult", () => {
  it("reports the RPC count for an assignment-wide release", () => {
    const msg = describeReleaseAllResult({ affected: 37, action: "released" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("Released the grading review for 37 submissions in this assignment");
  });

  it("uses the unrelease verb for an assignment-wide unrelease", () => {
    const msg = describeReleaseAllResult({ affected: 37, action: "unreleased" });
    expect(msg.status).toBe("success");
    expect(msg.description).toContain("Unreleased the grading review for 37 submissions in this assignment");
  });

  it("carries the same 'other rounds untouched' signal as the per-submission path", () => {
    // Both paths scope to submissions.grading_review_id, so both toasts must say so — the whole
    // point of the fix is that meta-grader comments are no longer published.
    const bulk = describeBulkReleaseResult({ affected: 2, selectedCount: 3, action: "released" });
    const all = describeReleaseAllResult({ affected: 2, action: "released" });
    expect(all.description).toContain("Self-review and meta-grading rounds were not changed");
    expect(bulk.description).toContain("Self-review and meta-grading rounds were not changed");
  });

  it("never invents a denominator, since the panel's totals are per student", () => {
    const msg = describeReleaseAllResult({ affected: 12, action: "released" });
    expect(msg.description).not.toMatch(/\bof\s+\d+/);
  });

  it("warns instead of claiming success when an assignment-wide release is a no-op", () => {
    const msg = describeReleaseAllResult({ affected: 0, action: "released" });
    expect(msg.status).toBe("warning");
    expect(msg.title).toBe("Nothing to release");
    expect(msg.description).toContain("already released");
    expect(msg.description).toContain("no active submission with a grading review");
  });

  it("warns with the right wording for a no-op assignment-wide unrelease", () => {
    const msg = describeReleaseAllResult({ affected: 0, action: "unreleased" });
    expect(msg.status).toBe("warning");
    expect(msg.title).toBe("Nothing to unrelease");
    expect(msg.description).toContain("not released");
  });

  it("uses the singular for a single submission", () => {
    const msg = describeReleaseAllResult({ affected: 1, action: "released" });
    expect(msg.description).toContain("1 submission in this assignment");
  });
});
