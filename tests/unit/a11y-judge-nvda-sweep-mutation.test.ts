/**
 * Unit tests for the sweep-mutation reporting surface added for issue #913
 * (tools/a11y-judge/nvda/report.ts).
 *
 * The defect these guard against is a REPORTING one as much as a driver one.
 * #913 was filed against the app — "NVDA announces all three survey options as
 * checked", WCAG 4.1.2 — when NVDA had reported the state correctly every time:
 * the driver's own `next` sweep is ArrowDown, and in NVDA focus mode an arrow
 * inside a radio group moves AND selects. The run stayed green because the
 * survey lane asserted only `survey_responses.is_submitted === true` and nothing
 * anywhere said the sweep had touched the answers. So a mutation must reach the
 * summary, and it must say which way the answer moved.
 *
 * LOCATION NOTE: this repo's jest config only discovers tests under tests/unit,
 * so the test lives here and imports from tools/ (matching the sibling
 * a11y-judge-report / a11y-judge-evidence tests).
 */
import { describeSweepMutation, renderSummary, type TaskReport } from "../../tools/a11y-judge/nvda/report";
import type { SweepMutation } from "../../tools/a11y-judge/nvda/nvdaHarness";

function mutation(overrides: Partial<SweepMutation> = {}): SweepMutation {
  return {
    stepIndex: 42,
    command: "next",
    kind: "radio",
    key: "q2_sq_7",
    before: "Just right",
    after: "Too fast",
    leftFocusMode: true,
    restore: "restored|q2_sq_7|Just right",
    restored: true,
    ...overrides
  };
}

function report(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    id: "survey-taking__survey-complete",
    pageId: "survey-taking",
    taskId: "survey-complete",
    taskKind: "write",
    status: "passed",
    durationMs: 61_000,
    stepCount: 30,
    resyncs: [],
    steps: [],
    ...overrides
  };
}

describe("describeSweepMutation", () => {
  it("names the control and both answers, so the reader can see the sweep wrote", () => {
    const line = describeSweepMutation(mutation());
    expect(line).toContain("step 42");
    expect(line).toContain("next");
    expect(line).toContain('"q2_sq_7"');
    expect(line).toContain('"Just right"');
    expect(line).toContain('"Too fast"');
  });

  it("distinguishes a confirmed restore from a failed one", () => {
    expect(describeSweepMutation(mutation())).toContain("restore: confirmed");
    const failed = describeSweepMutation(mutation({ restored: false, restore: "no-element|" }));
    expect(failed).toContain("restore: FAILED");
    expect(failed).toContain("no-element|");
  });

  // "The guard never ran" and "the guard ran and the arrow mutated anyway" are
  // different bugs: only the second means NVDA was still in focus mode after an
  // Escape, so the flag has to survive into the rendered line.
  it("reports whether the pre-emptive exitFocusMode fired", () => {
    expect(describeSweepMutation(mutation({ leftFocusMode: true }))).toContain("left focus mode first: true");
    expect(describeSweepMutation(mutation({ leftFocusMode: false }))).toContain("left focus mode first: false");
  });
});

describe("renderSummary sweep-mutation section", () => {
  it("is absent when no sweep changed anything", () => {
    const summary = renderSummary([report()], {});
    expect(summary).not.toContain("Sweep mutations");
  });

  // The load-bearing case: the task PASSED its predicate, and the mutation is
  // the only thing saying the recorded answer belongs to the driver.
  it("appears for a PASSED task whose sweep changed an answer", () => {
    const summary = renderSummary([report({ sweepMutations: [mutation()] })], {});
    expect(summary).toContain("Sweep mutations");
    expect(summary).toContain("survey-taking__survey-complete");
    expect(summary).toContain('"Just right"');
    expect(summary).toContain('"Too fast"');
    expect(summary).toContain("#913");
  });

  it("lists every mutating step, not just the first", () => {
    const summary = renderSummary(
      [
        report({
          sweepMutations: [
            mutation({ stepIndex: 10, after: "Too fast" }),
            mutation({ stepIndex: 11, command: "previous", before: "Too fast", after: "Too slow" })
          ]
        })
      ],
      {}
    );
    expect(summary).toContain("step 10");
    expect(summary).toContain("step 11");
    expect(summary).toContain("previous");
  });
});
