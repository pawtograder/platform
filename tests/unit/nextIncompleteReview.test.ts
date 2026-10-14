import { pickNextIncompleteReview, type NextReviewCandidate } from "@/lib/nextIncompleteReview";

const sub = (submissionId: number, incomplete: number[], complete = 0): NextReviewCandidate => ({
  submissionId,
  reviewAssignmentId: incomplete[0] ?? (complete ? submissionId * 100 : undefined),
  hasIncompleteReview: incomplete.length > 0,
  incompleteReviewAssignmentIds: incomplete
});

describe("pickNextIncompleteReview", () => {
  it("stays on this submission while another of my reviews here is incomplete", () => {
    const options = [sub(10, [101, 102]), sub(20, [201])];
    expect(pickNextIncompleteReview(options, 10, 101)).toEqual({ submissionId: 10, reviewAssignmentId: 102 });
  });

  it("moves to the next submission by id once the active review is the last one here", () => {
    const options = [sub(10, [101]), sub(20, [201]), sub(30, [301])];
    expect(pickNextIncompleteReview(options, 10, 101)).toEqual({ submissionId: 20, reviewAssignmentId: 201 });
  });

  it("wraps around to the first incomplete submission", () => {
    const options = [sub(10, [101]), sub(20, [201]), sub(30, [], 1)];
    expect(pickNextIncompleteReview(options, 30, undefined)).toEqual({ submissionId: 10, reviewAssignmentId: 101 });
  });

  it("opens an incomplete review here when no review is active on this submission", () => {
    const options = [sub(10, [101]), sub(20, [201])];
    expect(pickNextIncompleteReview(options, 10, undefined)).toEqual({ submissionId: 10, reviewAssignmentId: 101 });
  });

  it("returns undefined when the active review is the only incomplete one left", () => {
    const options = [sub(10, [101]), sub(20, [], 1)];
    expect(pickNextIncompleteReview(options, 10, 101)).toBeUndefined();
  });
});
