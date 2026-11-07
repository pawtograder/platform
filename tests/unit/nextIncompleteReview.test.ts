import { pickNextIncompleteReview, type NextReviewCandidate } from "@/lib/nextIncompleteReview";

/** A submission with my incomplete review assignments, given as [assignment id, submission review id]. */
const sub = (submissionId: number, incomplete: [number, number][], complete = 0): NextReviewCandidate => ({
  submissionId,
  reviewAssignmentId: incomplete[0]?.[0] ?? (complete ? submissionId * 100 : undefined),
  hasIncompleteReview: incomplete.length > 0,
  incompleteReviews: incomplete.map(([id, submissionReviewId]) => ({ id, submissionReviewId }))
});

describe("pickNextIncompleteReview", () => {
  it("stays on this submission while another of my reviews here is incomplete", () => {
    const options = [
      sub(10, [
        [101, 1],
        [102, 2]
      ]),
      sub(20, [[201, 3]])
    ];
    expect(pickNextIncompleteReview(options, 10, { activeReviewAssignmentId: 101 })).toEqual({
      submissionId: 10,
      reviewAssignmentId: 102
    });
  });

  it("moves to the next submission by id once the active review is the last one here", () => {
    const options = [sub(10, [[101, 1]]), sub(20, [[201, 2]]), sub(30, [[301, 3]])];
    expect(pickNextIncompleteReview(options, 10, { activeReviewAssignmentId: 101 })).toEqual({
      submissionId: 20,
      reviewAssignmentId: 201
    });
  });

  it("wraps around to the first incomplete submission", () => {
    const options = [sub(10, [[101, 1]]), sub(20, [[201, 2]]), sub(30, [], 1)];
    expect(pickNextIncompleteReview(options, 30)).toEqual({ submissionId: 10, reviewAssignmentId: 101 });
  });

  it("opens an incomplete review here when no review is active on this submission", () => {
    const options = [sub(10, [[101, 1]]), sub(20, [[201, 2]])];
    expect(pickNextIncompleteReview(options, 10)).toEqual({ submissionId: 10, reviewAssignmentId: 101 });
  });

  it("skips assignments on the submission review being completed, which the completion trigger closes", () => {
    // "View + Grade Full Rubric": no active assignment, but completing submission review 1 also
    // completes assignment 101 on it.
    const options = [sub(10, [[101, 1]]), sub(20, [[201, 2]])];
    expect(pickNextIncompleteReview(options, 10, { submissionReviewId: 1 })).toEqual({
      submissionId: 20,
      reviewAssignmentId: 201
    });
  });

  it("returns undefined when the completion closes the only incomplete review left", () => {
    expect(
      pickNextIncompleteReview([sub(10, [[101, 1]]), sub(20, [], 1)], 10, { submissionReviewId: 1 })
    ).toBeUndefined();
    expect(
      pickNextIncompleteReview([sub(10, [[101, 1]]), sub(20, [], 1)], 10, { activeReviewAssignmentId: 101 })
    ).toBeUndefined();
  });
});
