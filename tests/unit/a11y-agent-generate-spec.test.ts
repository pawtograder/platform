/**
 * Wave-4 unit tests: replay-plan distillation + generated spec source, from a
 * literal fixture trajectory (no browser, no LLM).
 */
import { buildReplayPlan, renderSpecSource } from "../../tools/a11y-judge/agent/generateSpec";
import { TRAJECTORY_SCHEMA_VERSION, type Trajectory } from "../../tools/a11y-judge/schema/trajectory";

const BINDINGS = { surveyTitle: "Agent Survey", assignmentName: "Agent Assignment" };

function step(index: number, tool: string, args: Record<string, string>, currentItem: string): Trajectory["steps"][0] {
  return {
    index,
    tool,
    argsJson: JSON.stringify(args),
    resultJson: JSON.stringify({ spokenSinceLastAction: [], currentItem, domFocus: null }),
    rawSpoken: [],
    startedTimestamp: "2026-07-14T10:00:00.000Z",
    endedTimestamp: "2026-07-14T10:00:00.000Z"
  };
}

const TRAJECTORY: Trajectory = {
  meta: {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    pageId: "survey-taking",
    taskId: "survey-complete",
    route: "/course/1/surveys/x",
    model: "claude-opus-4-8",
    promptVersion: "a1.0",
    sampleIndex: 0,
    browser: "chromium",
    startedTimestamp: "2026-07-14T10:00:00.000Z",
    endedTimestamp: "2026-07-14T10:00:00.000Z"
  },
  steps: [
    step(0, "moveToNextHeading", {}, "What is your name?"),
    step(1, "next", {}, "textbox, What is your name?"),
    step(2, "interact", {}, "textbox, What is your name?"),
    step(3, "type", { text: "Ada Lovelace" }, "textbox, What is your name?"),
    step(4, "observe", {}, "textbox, What is your name?"),
    step(5, "next", {}, "button, Complete"),
    step(6, "act", {}, "button, Complete")
  ],
  assistantNotes: [],
  contentHash: "abc123"
};

describe("buildReplayPlan", () => {
  const plan = buildReplayPlan(TRAJECTORY, BINDINGS);

  it("keeps commands + args, drops observe steps", () => {
    expect(plan.steps.map((s) => s.command)).toEqual(["moveToNextHeading", "next", "interact", "type", "next", "act"]);
    expect(plan.steps[3].arg).toBe("Ada Lovelace");
  });

  it("attaches normalized pre-action milestones to state-changing steps only", () => {
    const byCommand = Object.fromEntries(plan.steps.map((s) => [s.command, s]));
    expect(byCommand.interact.milestone).toBe("textbox, what is your name?");
    expect(byCommand.type.milestone).toBe("textbox, what is your name?");
    // act's milestone comes from the step before it (the cursor on Complete).
    expect(byCommand.act.milestone).toBe("button, complete");
    expect(byCommand.next.milestone).toBeUndefined();
    expect(byCommand.moveToNextHeading.milestone).toBeUndefined();
  });

  it("carries task kind, needles, and provenance", () => {
    expect(plan.taskKind).toBe("write");
    expect(plan.readNeedleKeys).toEqual([]);
    expect(plan.sourceTrajectoryHash).toBe("abc123");
    expect(plan.pageId).toBe("survey-taking");
  });

  it("throws on a trajectory for an unknown task", () => {
    const alien = { ...TRAJECTORY, meta: { ...TRAJECTORY.meta, taskId: "nope" } };
    expect(() => buildReplayPlan(alien, BINDINGS)).toThrow(/unknown task/);
  });
});

describe("renderSpecSource", () => {
  const source = renderSpecSource(buildReplayPlan(TRAJECTORY, BINDINGS), "run-x");

  it("emits an A11Y_TASKS-gated spec embedding the plan and provenance", () => {
    expect(source).toContain("test.skip(!process.env.A11Y_TASKS");
    expect(source).toContain('"sourceTrajectoryHash": "abc123"');
    expect(source).toContain("run-x");
    expect(source).toContain("replay: survey-taking__survey-complete");
    expect(source).toContain("AUTO-GENERATED");
  });

  it("runs the machine predicate for write tasks", () => {
    expect(source).toContain('PLAN.taskKind === "write"');
    expect(source).toContain("getTask(PLAN.taskId)!.predicate");
  });

  it("emits test.fixme with the reason when a task is blocked by an app defect", () => {
    const blocked = renderSpecSource(buildReplayPlan(TRAJECTORY, BINDINGS), "run-x", "autosave race");
    expect(blocked).toContain("test.fixme(true,");
    expect(blocked).toContain("autosave race");
  });

  it("omits test.fixme for unblocked tasks", () => {
    expect(source).not.toContain("test.fixme");
  });

  it("emits env-branched video mode (recording, overlay, pacing, sidecar)", () => {
    expect(source).toContain("const VIDEO = Boolean(process.env.A11Y_VIDEO)");
    expect(source).toContain('video: VIDEO ? "on" : "off"');
    expect(source).toContain("AtHarness.install(page, { videoOverlay: VIDEO })");
    expect(source).toContain("stepPauseMs: VIDEO ? VIDEO_STEP_PAUSE_MS : 0");
    expect(source).toContain('testInfo.outputPath("a11y-video-meta.json")');
    // The sidecar must carry the promised video path but never copy in-process
    // (videos only finalize on context close — collector copies post-run).
    expect(source).toContain("page.video()?.path()");
    expect(source).not.toContain("saveAs");
  });
});
