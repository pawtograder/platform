/**
 * Wave-3 unit tests: task-suite pure helpers and read-task predicates run
 * against literal fixtures (no DB — write-task predicates get fake query fns).
 */
import {
  DISCUSSION_REPLY_TASK,
  DISCUSSION_SUBJECT_TASK,
  GRADEBOOK_COLUMNS_TASK,
  normalizeAnswer,
  OFFICE_HOURS_REQUEST_TASK,
  RESULTS_SCORE_TASK,
  SUBMISSION_FILES_TASK,
  SURVEY_COMPLETE_TASK,
  TASKS,
  type TaskContext
} from "../../tools/a11y-judge/agent/tasks";
import type { AgentVerdict } from "../../tools/a11y-judge/schema/trajectory";

function verdictWithAnswer(taskAnswer: string): AgentVerdict {
  return {
    taskId: "t",
    outcome: "completed",
    taskAnswer,
    confidence: "high",
    narrative: "",
    barriers: [],
    evidenceGaps: []
  };
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    seed: {
      surveyId: "s-1",
      studentProfileId: "p-1",
      classId: "77",
      assignmentName: "Agent Assignment",
      autograderScore: "5",
      autograderMax: "10",
      threadId: "900",
      threadSubject: "Office hours schedule question",
      codeFileName: "Calculator.java",
      codeMarkerText: "the hidden treasure is calibrated precision",
      seededHelpRequestId: "500"
    },
    queryRow: async () => null,
    queryRowContains: async () => null,
    ...overrides
  };
}

describe("normalizeAnswer", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeAnswer("  Agent   ASSIGNMENT\n")).toBe("agent assignment");
  });
});

describe("read-task predicates", () => {
  it("results-score accepts an answer containing score, max, and a test mention", async () => {
    const good = await RESULTS_SCORE_TASK.predicate(
      verdictWithAnswer("The autograder shows 5 out of 10; 'test 1' passed."),
      ctx()
    );
    expect(good.success).toBe(true);
    const bad = await RESULTS_SCORE_TASK.predicate(verdictWithAnswer("Score looked fine to me"), ctx());
    expect(bad.success).toBe(false);
  });

  it("gradebook task matches the assignment name case-insensitively", async () => {
    const good = await GRADEBOOK_COLUMNS_TASK.predicate(
      verdictWithAnswer("I found AGENT assignment with score 5/10"),
      ctx()
    );
    expect(good.success).toBe(true);
  });

  it("discussion-subject requires the seeded subject", async () => {
    const good = await DISCUSSION_SUBJECT_TASK.predicate(
      verdictWithAnswer("Subject: Office Hours Schedule Question, 0 replies"),
      ctx()
    );
    expect(good.success).toBe(true);
    const bad = await DISCUSSION_SUBJECT_TASK.predicate(verdictWithAnswer("A thread about office hours"), ctx());
    expect(bad.success).toBe(false);
  });

  it("read tasks fail on a missing verdict instead of throwing", async () => {
    const res = await DISCUSSION_SUBJECT_TASK.predicate(null, ctx());
    expect(res).toEqual({ success: false, detail: "no verdict emitted" });
  });

  it("code-marker requires the seeded marker comment text", async () => {
    const good = await SUBMISSION_FILES_TASK.predicate(
      verdictWithAnswer("The A11Y-MARKER comment says: The Hidden Treasure is calibrated precision."),
      ctx()
    );
    expect(good.success).toBe(true);
    const bad = await SUBMISSION_FILES_TASK.predicate(
      verdictWithAnswer("I found a comment about treasure in Calculator.java"),
      ctx()
    );
    expect(bad.success).toBe(false);
  });
});

describe("write-task predicates", () => {
  it("survey-complete demands is_submitted=true, not just a row", async () => {
    const notSubmitted = await SURVEY_COMPLETE_TASK.predicate(
      null,
      ctx({ queryRow: async () => ({ is_submitted: false }) })
    );
    expect(notSubmitted.success).toBe(false);
    const submitted = await SURVEY_COMPLETE_TASK.predicate(
      null,
      ctx({ queryRow: async () => ({ is_submitted: true }) })
    );
    expect(submitted.success).toBe(true);
  });

  it("discussion-reply rejects the marker text matching only the root thread", async () => {
    const rootOnly = await DISCUSSION_REPLY_TASK.predicate(null, ctx({ queryRowContains: async () => ({ id: 900 }) }));
    expect(rootOnly.success).toBe(false);
    const realReply = await DISCUSSION_REPLY_TASK.predicate(null, ctx({ queryRowContains: async () => ({ id: 901 }) }));
    expect(realReply.success).toBe(true);
  });

  it("help-request rejects the marker text matching only the seeded request", async () => {
    const seededOnly = await OFFICE_HOURS_REQUEST_TASK.predicate(
      null,
      ctx({ queryRowContains: async () => ({ id: 500 }) })
    );
    expect(seededOnly.success).toBe(false);
    const newRequest = await OFFICE_HOURS_REQUEST_TASK.predicate(
      null,
      ctx({ queryRowContains: async () => ({ id: 501 }) })
    );
    expect(newRequest.success).toBe(true);
    const missing = await OFFICE_HOURS_REQUEST_TASK.predicate(null, ctx());
    expect(missing.success).toBe(false);
  });
});

describe("suite", () => {
  it("covers all nine student pages", () => {
    expect(new Set(TASKS.map((t) => t.pageId))).toEqual(
      new Set([
        "survey-taking",
        "autograder-results",
        "grade-summary",
        "gradebook",
        "discussion",
        "assignments-list",
        "submission-files",
        "regrade-requests",
        "office-hours"
      ])
    );
  });
});
