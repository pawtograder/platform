/**
 * Wave-2 unit tests: trajectory schema — content-hash stability across
 * wall-clock (the `*Timestamp` naming contract with the shared canonicalizer)
 * and hallucinated-citation rejection in postValidateAgentVerdict.
 */
import {
  computeTrajectoryHash,
  parseBarriersJson,
  postValidateAgentVerdict,
  TRAJECTORY_SCHEMA_VERSION,
  type AgentVerdict,
  type Trajectory
} from "../../tools/a11y-judge/schema/trajectory";

function makeTrajectoryBody(startedTimestamp: string): Omit<Trajectory, "contentHash"> {
  return {
    meta: {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      pageId: "survey-taking",
      taskId: "survey-complete",
      route: "/course/1/surveys/abc",
      model: "claude-opus-4-8",
      promptVersion: "a1.0",
      sampleIndex: 0,
      browser: "chromium",
      startedTimestamp,
      endedTimestamp: startedTimestamp
    },
    steps: [
      {
        index: 0,
        tool: "next",
        argsJson: "{}",
        resultJson: '{"spokenSinceLastAction":["heading, Survey, level 1"],"currentItem":"heading, Survey, level 1","domFocus":null}',
        rawSpoken: ["heading, Survey, level 1"],
        startedTimestamp,
        endedTimestamp: startedTimestamp
      },
      {
        index: 1,
        tool: "act",
        argsJson: "{}",
        resultJson: '{"spokenSinceLastAction":[],"currentItem":"button, Complete","domFocus":null}',
        rawSpoken: [],
        startedTimestamp,
        endedTimestamp: startedTimestamp
      }
    ],
    assistantNotes: [{ role: "assistant_note", afterStepIndex: 1, text: "done" }]
  };
}

describe("computeTrajectoryHash", () => {
  it("is stable across differing wall-clock timestamps (identical behavior)", () => {
    const early = computeTrajectoryHash(makeTrajectoryBody("2026-07-14T10:00:00.000Z"));
    const late = computeTrajectoryHash(makeTrajectoryBody("2026-07-15T22:33:44.555Z"));
    expect(early).toBe(late);
  });

  it("changes when a step's behavior changes", () => {
    const base = makeTrajectoryBody("2026-07-14T10:00:00.000Z");
    const mutated = makeTrajectoryBody("2026-07-14T10:00:00.000Z");
    mutated.steps[1].tool = "press";
    expect(computeTrajectoryHash(base)).not.toBe(computeTrajectoryHash(mutated));
  });
});

describe("postValidateAgentVerdict", () => {
  const trajectory = { steps: makeTrajectoryBody("2026-07-14T10:00:00.000Z").steps };
  const goodBarrier = {
    summary: "Complete button announced with no name",
    severity: "4" as const,
    evidenceRefs: ["1"],
    elementPointer: { ariaName: "Complete" },
    suggestedFix: "add aria-label",
    wcagCriterion: "4.1.2"
  };
  const fabricatedBarrier = { ...goodBarrier, summary: "hallucinated", evidenceRefs: ["17", "step-99"] };
  const verdict: AgentVerdict = {
    taskId: "survey-complete",
    outcome: "completed_with_barriers",
    taskAnswer: "n/a",
    confidence: "medium",
    narrative: "n",
    barriers: [goodBarrier, fabricatedBarrier],
    evidenceGaps: []
  };

  it("keeps barriers citing real step indices, rejects fabricated ones", () => {
    const { verdict: validated, rejectedBarriers } = postValidateAgentVerdict(verdict, trajectory);
    expect(validated.barriers).toEqual([goodBarrier]);
    expect(rejectedBarriers).toEqual([fabricatedBarrier]);
  });

  it("accepts 'step-N' formatted refs for existing steps", () => {
    const stepRef = { ...goodBarrier, evidenceRefs: ["step-0"] };
    const { verdict: validated } = postValidateAgentVerdict({ ...verdict, barriers: [stepRef] }, trajectory);
    expect(validated.barriers).toEqual([stepRef]);
  });

  it("rejects barriers with no citations at all", () => {
    const uncited = { ...goodBarrier, evidenceRefs: [] };
    const { rejectedBarriers } = postValidateAgentVerdict({ ...verdict, barriers: [uncited] }, trajectory);
    expect(rejectedBarriers).toEqual([uncited]);
  });
});

describe("parseBarriersJson (wire string → Barrier[])", () => {
  const barrier = {
    summary: "radio state change not announced",
    severity: "3",
    evidenceRefs: ["12"],
    elementPointer: { ariaName: "Just right" },
    suggestedFix: "ensure aria-checked change is announced",
    wcagCriterion: "4.1.2"
  };

  it("parses a valid JSON array", () => {
    const { barriers, parseError } = parseBarriersJson(JSON.stringify([barrier]));
    expect(parseError).toBeUndefined();
    expect(barriers).toEqual([barrier]);
  });

  it('parses "[]" to no barriers', () => {
    expect(parseBarriersJson("[]")).toEqual({ barriers: [] });
  });

  it("reports malformed JSON instead of throwing", () => {
    const { barriers, parseError } = parseBarriersJson("[{oops");
    expect(barriers).toEqual([]);
    expect(parseError).toMatch(/not valid JSON/);
  });

  it("reports schema-invalid barrier objects", () => {
    const { barriers, parseError } = parseBarriersJson(JSON.stringify([{ summary: "x", severity: 3 }]));
    expect(barriers).toEqual([]);
    expect(parseError).toMatch(/failed validation/);
  });
});
