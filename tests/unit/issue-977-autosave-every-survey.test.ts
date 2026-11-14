/**
 * Regression tests for #977: a student's survey answers were lost on refresh unless the survey
 * allowed response editing.
 *
 * Autosave was gated on allow_response_editing, which is off by default, so nothing reached the
 * database until Complete. shouldAutosaveResponse (lib/surveyResponseState.ts) now autosaves every
 * draft, and lets allow_response_editing decide only whether a submitted response may still change.
 *
 * The file name starts with "issue-" so CI runs it: the e2e lane's jest step selects
 * `--testPathPatterns "tests/unit/issue"`, and jest-unit-tests runs a fixed list of other files.
 */
import { isSameResponseData, resolveResponseWriteFlags, shouldAutosaveResponse } from "@/lib/surveyResponseState";

describe("shouldAutosaveResponse (issue #977)", () => {
  test("a draft autosaves on a survey that does not allow editing", () => {
    // The bug: autosave was gated on allow_response_editing, which is off by default, so nothing
    // was written until Complete and a refresh lost every answer.
    expect(shouldAutosaveResponse({ loadedState: "draft", allowResponseEditing: false })).toBe(true);
  });

  test("a draft autosaves on a survey that allows editing", () => {
    expect(shouldAutosaveResponse({ loadedState: "draft", allowResponseEditing: true })).toBe(true);
  });

  test("a submitted response autosaves its edits only when the survey allows editing", () => {
    expect(shouldAutosaveResponse({ loadedState: "submitted", allowResponseEditing: true })).toBe(true);
    // Read-only form, and RLS refuses the update: there is nothing to save.
    expect(shouldAutosaveResponse({ loadedState: "submitted", allowResponseEditing: false })).toBe(false);
  });

  test("an unreadable row still reaches the write rules, which skip it", () => {
    // shouldAutosaveResponse does not duplicate the unknown-state rule; resolveResponseWriteFlags owns it.
    expect(shouldAutosaveResponse({ loadedState: "unknown", allowResponseEditing: false })).toBe(true);
    expect(resolveResponseWriteFlags({ isSubmitted: false, loadedState: "unknown" }).skip).toBe(true);
  });
});

describe("isSameResponseData (reading back a Complete that timed out)", () => {
  test("matches the answers stored as jsonb, whatever order the keys come back in", () => {
    const sent = { q1: "First", q2: ["b", "a"], q3: { rows: { r2: 2, r1: 1 } } };
    const stored = JSON.parse('{"q3": {"rows": {"r1": 1, "r2": 2}}, "q2": ["b", "a"], "q1": "First"}');
    expect(isSameResponseData(stored, sent)).toBe(true);
  });

  test("ignores answers the browser holds as undefined, which the upsert never sent", () => {
    expect(isSameResponseData({ q1: "First" }, { q1: "First", q2: undefined })).toBe(true);
  });

  test("tells different answers apart", () => {
    expect(isSameResponseData({ q1: "Draft" }, { q1: "Submitted" })).toBe(false);
    expect(isSameResponseData({ q2: ["a", "b"] }, { q2: ["b", "a"] })).toBe(false);
    expect(isSameResponseData({ q1: "First" }, { q1: "First", q2: "Second" })).toBe(false);
    expect(isSameResponseData(null, { q1: "First" })).toBe(false);
  });
});
