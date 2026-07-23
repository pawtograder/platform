/**
 * Wave-5 unit tests: evaluation metric pure functions.
 */
import {
  meanPairwiseToolVariance,
  mutationDetection,
  normalizeSc,
  sequenceEditDistance,
  taskReliability,
  type SampleData
} from "../../tools/a11y-judge/agent/metrics";

function sample(overrides: Partial<SampleData>): SampleData {
  return {
    cell: "survey-taking__survey-complete",
    pageId: "survey-taking",
    taskId: "survey-complete",
    sampleIndex: 0,
    outcome: "completed",
    predicateSuccess: true,
    isError: false,
    salvaged: false,
    steps: 30,
    turns: 40,
    costUsd: 1,
    toolSequence: ["next", "act"],
    barrierCriteria: [],
    mutationId: null,
    mutationCriterion: null,
    ...overrides
  };
}

describe("sequenceEditDistance", () => {
  it("is 0 for identical sequences and counts single edits", () => {
    expect(sequenceEditDistance(["a", "b"], ["a", "b"])).toBe(0);
    expect(sequenceEditDistance(["a", "b"], ["a", "c"])).toBe(1);
    expect(sequenceEditDistance(["a"], ["a", "b", "c"])).toBe(2);
  });
});

describe("meanPairwiseToolVariance", () => {
  it("is 0 for one or identical sequences", () => {
    expect(meanPairwiseToolVariance([["a", "b"]])).toBe(0);
    expect(meanPairwiseToolVariance([["a", "b"], ["a", "b"], ["a", "b"]])).toBe(0);
  });

  it("normalizes by the longer sequence", () => {
    expect(meanPairwiseToolVariance([["a", "b"], ["a", "c"]])).toBeCloseTo(0.5);
  });
});

describe("normalizeSc", () => {
  it("extracts the SC number from a verbose label", () => {
    expect(normalizeSc("4.1.2 Name, Role, Value (Level A)")).toBe("4.1.2");
    expect(normalizeSc("2.4.3")).toBe("2.4.3");
  });
});

describe("taskReliability", () => {
  it("summarizes a mixed clean cell", () => {
    const r = taskReliability([
      sample({ predicateSuccess: true, outcome: "completed", steps: 20, toolSequence: ["a", "b"] }),
      sample({ predicateSuccess: true, outcome: "completed", steps: 30, toolSequence: ["a", "b"] }),
      sample({ predicateSuccess: false, outcome: "blocked", steps: 40, toolSequence: ["a", "c"] })
    ]);
    expect(r.predicatePassRate).toBeCloseTo(2 / 3);
    expect(r.modalOutcome).toBe("completed");
    expect(r.outcomeConsistency).toBeCloseTo(2 / 3);
    expect(r.meanSteps).toBe(30);
  });
});

describe("mutationDetection", () => {
  const criterion = "4.1.2 Name, Role, Value (Level A)";
  it("counts blocked, SC-match, and detection (union)", () => {
    const d = mutationDetection(
      [
        // blocked, no matching barrier
        sample({ predicateSuccess: false, outcome: "blocked", mutationId: "412-strip-labels", mutationCriterion: criterion, barrierCriteria: [] }),
        // not blocked, but reported the matching SC
        sample({ predicateSuccess: true, outcome: "completed_with_barriers", mutationId: "412-strip-labels", mutationCriterion: criterion, barrierCriteria: ["4.1.2"] }),
        // clean pass, missed it
        sample({ predicateSuccess: true, outcome: "completed", mutationId: "412-strip-labels", mutationCriterion: criterion, barrierCriteria: [] })
      ],
      25
    );
    expect(d.blockedRate).toBeCloseTo(1 / 3);
    expect(d.scMatchRate).toBeCloseTo(1 / 3);
    expect(d.detectionRate).toBeCloseTo(2 / 3);
  });

  it("computes steps delta vs clean baseline", () => {
    const d = mutationDetection([sample({ steps: 40, mutationId: "x", mutationCriterion: "1.1.1" })], 25);
    expect(d.meanStepsDelta).toBe(15);
  });
});
