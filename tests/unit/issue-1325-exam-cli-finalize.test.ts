/**
 * @jest-environment node
 */

/**
 * #1325: `pawtograder exams scans process` and `finalize --dry-run`.
 *
 * enqueue_exam_process_batch has no status guard; the Scans page only offers Process for a new or
 * errored batch. Without the same rule, processing a completed batch sends it back to review.
 *
 * The dry run is what an operator checks before creating submissions, so it has to say what
 * enqueue_exam_finalize will actually do: only confirmed exams that are not yet finalized become
 * submissions. Listing a suggested match as "create", or a student's pages out of order, would
 * have them approve a plan the RPC does not carry out.
 */

import { planFinalize, processBatchError } from "@/supabase/functions/cli/utils/examScans";

describe("processBatchError", () => {
  it.each(["uploaded", "error"])("allows processing a batch that is %s", (status) => {
    expect(processBatchError(status)).toBeNull();
  });

  it.each(["ocr", "matching", "review", "finalizing", "completed"])(
    "refuses to process a batch that is %s",
    (status) => {
      expect(processBatchError(status)).toContain(status);
    }
  );
});

describe("planFinalize", () => {
  it.each([
    ["confirmed", null, "create"],
    ["suggested", null, "needs_review"],
    ["unmatched", null, "needs_review"],
    ["skipped", null, "skipped"],
    ["confirmed", "2026-11-18T00:00:00Z", "already_created"]
  ])("a %s exam with finalized_at %p is planned as %s", (matchStatus, finalizedAt, action) => {
    const [row] = planFinalize(
      [{ id: 1, exam_index: 0, match_status: matchStatus, matched_profile_id: "p1", finalized_at: finalizedAt }],
      [],
      new Map([["p1", "Alice Smith"]])
    );
    expect(row.action).toBe(action);
  });

  it("lists each exam's pages in page_index order, and exams in exam_index order", () => {
    const plan = planFinalize(
      [
        { id: 20, exam_index: 1, match_status: "confirmed", matched_profile_id: "p2", finalized_at: null },
        { id: 10, exam_index: 0, match_status: "confirmed", matched_profile_id: "p1", finalized_at: null }
      ],
      [
        { page_index: 3, scanned_submission_id: 20 },
        { page_index: 1, scanned_submission_id: 10 },
        { page_index: 2, scanned_submission_id: 20 },
        { page_index: 0, scanned_submission_id: 10 },
        { page_index: 4, scanned_submission_id: null }
      ],
      new Map([
        ["p1", "Alice Smith"],
        ["p2", "Bob Jones"]
      ])
    );
    expect(plan.map((r) => [r.exam_index, r.student_name, r.page_indexes])).toEqual([
      [0, "Alice Smith", [0, 1]],
      [1, "Bob Jones", [2, 3]]
    ]);
  });
});
