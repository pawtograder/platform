/**
 * Task suite for the agentic SR-driving runs (a11y-judge v2).
 *
 * Success is MACHINE-CHECKED, never self-reported: write-tasks verify app
 * state (DB rows via the host's admin client), read-tasks compare the agent's
 * `taskAnswer` against seed-derived ground truth. The predicate receives a
 * context the HOST fills from its own seeding — the agent never sees it.
 */
import type { AgentVerdict } from "../schema/trajectory";
import { tokenBoundaryPattern } from "./normalize";

export interface TaskContext {
  /** Host-seeded values (ids, expected answers) the predicates need. */
  seed: Record<string, string>;
  /** Admin equality-match single-row lookup, provided by the host spec. */
  queryRow: (table: string, match: Record<string, string>) => Promise<Record<string, unknown> | null>;
  /** Admin lookup with one ILIKE %needle% column plus equality matches. */
  queryRowContains: (
    table: string,
    contains: { column: string; needle: string },
    match: Record<string, string>
  ) => Promise<Record<string, unknown> | null>;
}

export interface PredicateResult {
  success: boolean;
  detail: string;
}

export interface TaskDefinition {
  id: string;
  pageId: string;
  /** Task statement given to the agent (no selectors, no app internals). */
  prompt: string;
  kind: "write" | "read";
  predicate: (verdict: AgentVerdict | null, ctx: TaskContext) => Promise<PredicateResult>;
  /**
   * For read-tasks: seed-binding KEYS whose values must be audible during a
   * deterministic replay (there is no agent to produce taskAnswer then).
   */
  readNeedleKeys?: string[];
  /**
   * When set, the generated replay spec is emitted as `test.fixme` (tracked but
   * not counted green) because a KNOWN APP DEFECT makes it nondeterministic.
   * The generated test still reproduces the defect and will pass once fixed.
   */
  replayBlockedBy?: string;
}

/** Normalize a free-text answer for comparison (mirrors S3 rules, minimal). */
export function normalizeAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Read-task helper: every needle must appear in the normalized taskAnswer as a
 * whole token. A plain substring check passes any answer that merely contains
 * the digits — with the seeded score 5 out of 10, "50 out of 100" would be
 * scored correct, so a real reading failure ships as a green run.
 */
function answerContains(verdict: AgentVerdict | null, needles: string[]): PredicateResult {
  if (!verdict) return { success: false, detail: "no verdict emitted" };
  // A needle read from `ctx.seed` is typed `string` but is really only as good
  // as the seeder: reference a key `seedAgentPages()` never sets and this used
  // to die inside normalizeAnswer with a bare "Cannot read properties of
  // undefined". Fail the predicate with the cause named instead.
  const unbound = needles.filter((n) => n === undefined || n === null || n === "");
  if (unbound.length > 0) {
    return { success: false, detail: `predicate needles missing from seed bindings: ${JSON.stringify(needles)}` };
  }
  const answer = normalizeAnswer(verdict.taskAnswer);
  const missing = needles.filter((n) => !tokenBoundaryPattern(normalizeAnswer(n)).test(answer));
  return missing.length === 0
    ? { success: true, detail: `taskAnswer contains ${JSON.stringify(needles)}` }
    : { success: false, detail: `taskAnswer ${JSON.stringify(answer)} missing ${JSON.stringify(missing)}` };
}

export const SURVEY_COMPLETE_TASK: TaskDefinition = {
  id: "survey-complete",
  pageId: "survey-taking",
  kind: "write",
  prompt: [
    "You are on a course survey page. Complete the survey thoughtfully and submit it:",
    "answer the name question with 'Ada Lovelace', choose the middle option for the pace question,",
    "check at least one topic, add a short comment, then submit the survey with the Complete button."
  ].join(" "),
  predicate: async (_verdict, ctx) => {
    const row = await ctx.queryRow("survey_responses", {
      survey_id: ctx.seed.surveyId,
      profile_id: ctx.seed.studentProfileId
    });
    if (!row) return { success: false, detail: "no survey_responses row exists" };
    if (row.is_submitted !== true) {
      return { success: false, detail: `survey_responses row exists but is_submitted=${String(row.is_submitted)}` };
    }
    return { success: true, detail: "survey_responses.is_submitted=true" };
  }
};

export const RESULTS_SCORE_TASK: TaskDefinition = {
  id: "results-score",
  pageId: "autograder-results",
  kind: "read",
  readNeedleKeys: ["autograderScore", "autograderMax"],
  prompt: [
    "You are on the automated grading results page for one of your assignment submissions.",
    "Find the autograder score for this submission and report it in taskAnswer in the form",
    "'<points> out of <max>' (e.g. '7 out of 10'). Also mention one automated test by name."
  ].join(" "),
  predicate: async (verdict, ctx) => answerContains(verdict, [ctx.seed.autograderScore, ctx.seed.autograderMax, "test"])
};

export const GRADE_ASSIGNMENT_TASK: TaskDefinition = {
  id: "grade-assignment-name",
  pageId: "grade-summary",
  kind: "read",
  readNeedleKeys: ["assignmentName"],
  prompt: [
    "You are on the grade summary page for one of your submissions. Report in taskAnswer the",
    "name of the assignment this page is about, and whether a final grade has been released."
  ].join(" "),
  predicate: async (verdict, ctx) => answerContains(verdict, [ctx.seed.assignmentName])
};

export const GRADEBOOK_COLUMNS_TASK: TaskDefinition = {
  id: "gradebook-assignment",
  pageId: "gradebook",
  kind: "read",
  // `gradebookSpokenScore` ("45 of 100 points") rather than a bare
  // `gradebookScore`: needles are matched as whole tokens against the speech
  // log, and a lone "45" would also be satisfied by any incidental number the
  // journey passes through. The multi-word phrase can only come from the score
  // cell itself. Needling the name alone let the lane pass while no score was
  // reachable at all (issue #915).
  readNeedleKeys: ["assignmentName", "gradebookSpokenScore"],
  prompt: [
    "You are on your course gradebook page. Find the assignment entries listed there and report",
    "in taskAnswer the name of each assignment you can find, and for each one the score and the",
    "maximum it is out of, in the form '<points> out of <max>' (e.g. '7 out of 10'). If no score",
    "is shown for an entry, say so explicitly instead of guessing."
  ].join(" "),
  predicate: async (verdict, ctx) =>
    answerContains(verdict, [ctx.seed.assignmentName, ctx.seed.gradebookScore, ctx.seed.gradebookMaxScore])
};

export const DISCUSSION_REPLY_TASK: TaskDefinition = {
  id: "discussion-reply",
  pageId: "discussion",
  kind: "write",
  prompt: [
    "You are on a discussion thread page. Read the thread, then post a reply that says exactly:",
    "'Screen reader navigation check reply.' Confirm it was posted."
  ].join(" "),
  predicate: async (_verdict, ctx) => {
    const row = await ctx.queryRowContains(
      "discussion_threads",
      { column: "body", needle: "Screen reader navigation check reply" },
      { class_id: ctx.seed.classId }
    );
    if (!row) return { success: false, detail: "no discussion_threads row contains the marker reply text" };
    if (String(row.id) === ctx.seed.threadId) {
      return { success: false, detail: "marker text found only on the seeded root thread, not a reply" };
    }
    return { success: true, detail: `reply row ${String(row.id)} contains the marker text` };
  }
};

export const DISCUSSION_SUBJECT_TASK: TaskDefinition = {
  id: "discussion-subject",
  pageId: "discussion",
  kind: "read",
  readNeedleKeys: ["threadSubject"],
  prompt: [
    "You are on a discussion thread page. Report in taskAnswer the exact subject/title of this",
    "thread and the number of replies it currently shows, if announced."
  ].join(" "),
  predicate: async (verdict, ctx) => answerContains(verdict, [ctx.seed.threadSubject])
};

export const ASSIGNMENTS_LIST_TASK: TaskDefinition = {
  id: "assignments-overview",
  pageId: "assignments-list",
  kind: "read",
  readNeedleKeys: ["assignmentName"],
  prompt: [
    "You are on your course assignments page. Report in taskAnswer the name of each assignment",
    "listed and, if announced, its due date and whether you have submitted it."
  ].join(" "),
  predicate: async (verdict, ctx) => answerContains(verdict, [ctx.seed.assignmentName])
};

export const SUBMISSION_FILES_TASK: TaskDefinition = {
  id: "code-marker",
  pageId: "submission-files",
  kind: "read",
  readNeedleKeys: ["codeMarkerText"],
  prompt: [
    "You are on the submitted-files page for one of your assignment submissions, which shows",
    "your submitted source code. Open the file named 'Calculator.java', read through its code,",
    "find the comment labeled 'A11Y-MARKER', and report the comment's text after that label in taskAnswer."
  ].join(" "),
  predicate: async (verdict, ctx) => answerContains(verdict, [ctx.seed.codeMarkerText])
};

export const REGRADE_STATUS_TASK: TaskDefinition = {
  id: "regrade-status",
  pageId: "regrade-requests",
  kind: "read",
  readNeedleKeys: ["assignmentName"],
  prompt: [
    "You are on your regrade requests page. Find your regrade request and report in taskAnswer",
    "which assignment it belongs to and its current status."
  ].join(" "),
  predicate: async (verdict, ctx) => answerContains(verdict, [ctx.seed.assignmentName])
};

export const OFFICE_HOURS_REQUEST_TASK: TaskDefinition = {
  id: "help-request",
  pageId: "office-hours",
  kind: "write",
  prompt: [
    "You are on your course office hours page. Create a new help request that asks exactly:",
    "'Keyboard-only navigation check: how do I run the autograder locally?'",
    "Submit it and confirm it was created."
  ].join(" "),
  predicate: async (_verdict, ctx) => {
    const row = await ctx.queryRowContains(
      "help_requests",
      { column: "request", needle: "Keyboard-only navigation check" },
      { class_id: ctx.seed.classId }
    );
    if (!row) return { success: false, detail: "no help_requests row contains the marker text" };
    if (String(row.id) === ctx.seed.seededHelpRequestId) {
      return { success: false, detail: "marker text found only on the seeded request, not a new one" };
    }
    return { success: true, detail: `help request row ${String(row.id)} contains the marker text` };
  }
};

export const TASKS: TaskDefinition[] = [
  SURVEY_COMPLETE_TASK,
  RESULTS_SCORE_TASK,
  GRADE_ASSIGNMENT_TASK,
  GRADEBOOK_COLUMNS_TASK,
  DISCUSSION_REPLY_TASK,
  DISCUSSION_SUBJECT_TASK,
  ASSIGNMENTS_LIST_TASK,
  SUBMISSION_FILES_TASK,
  REGRADE_STATUS_TASK,
  OFFICE_HOURS_REQUEST_TASK
];

export function getTask(id: string): TaskDefinition | undefined {
  return TASKS.find((t) => t.id === id);
}
