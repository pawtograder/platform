/**
 * Regression tests for the "a submitted survey response must never revert to a draft" rules in
 * lib/surveyResponseState.ts, used by app/course/[course_id]/surveys/[survey_id]/page.tsx.
 *
 * The bug these cover: the page's "already submitted" ref started false and was only ever set by
 * a submit performed in the same browser session, so it was never armed on a fresh page load. A
 * student returning to a survey with allow_response_editing = true gets a live, editable form --
 * correctly, since the SurveyJS model renders in its running state with a working Complete button
 * (components/Survey.tsx) -- and the first value change autosaved is_submitted:false over their
 * submission. The draft upsert omits submitted_at, so the row was left contradicting itself: not
 * submitted, but carrying a submit timestamp. get_survey_status_for_assignment then reported the
 * survey as incomplete.
 *
 * The database does not stop this: survey_responses_update_owner (20260817120000) explicitly
 * permits updating a submitted row when the survey allows response editing.
 *
 * The fix keeps the feature. Editing stays live, and an autosave on an already-submitted response
 * writes is_submitted:true with no submitted_at, so the edit persists, the row never leaves the
 * submitted state, and the original submission time survives.
 */
import {
  isSurveyResponseReadOnly,
  NO_ROWS_ERROR_CODE,
  resolveResponseWriteFlags,
  responseStateFromLoad
} from "@/lib/surveyResponseState";

describe("responseStateFromLoad", () => {
  test("recognises a submitted row loaded off the server", () => {
    // The fix: without this the page carries "draft" into an edit session on a response that is
    // already submitted, and autosave downgrades it.
    expect(responseStateFromLoad({ data: { is_submitted: true }, error: null })).toBe("submitted");
  });

  test("recognises a saved draft", () => {
    expect(responseStateFromLoad({ data: { is_submitted: false }, error: null })).toBe("draft");
  });

  test("treats a student with no response row yet as a draft", () => {
    expect(responseStateFromLoad({ data: null, error: { code: NO_ROWS_ERROR_CODE } })).toBe("draft");
  });

  test("reports unknown when the row could not be read", () => {
    expect(responseStateFromLoad({ data: null, error: { code: "PGRST301" } })).toBe("unknown");
  });
});

describe("resolveResponseWriteFlags", () => {
  test("an autosave on an already-submitted response stays submitted and keeps submitted_at", () => {
    // The heart of the fix: persist the edit, never write is_submitted:false, and leave
    // submitted_at out of the upsert so the stored submission time is not overwritten.
    expect(resolveResponseWriteFlags({ isSubmitted: false, loadedState: "submitted" })).toEqual({
      skip: false,
      isSubmitted: true,
      stampSubmittedAt: false
    });
  });

  test("an autosave on a draft still writes a draft", () => {
    expect(resolveResponseWriteFlags({ isSubmitted: false, loadedState: "draft" })).toEqual({
      skip: false,
      isSubmitted: false,
      stampSubmittedAt: false
    });
  });

  test("an autosave against an unreadable row is skipped, not guessed", () => {
    // Either guess corrupts: "draft" downgrades a submission, "submitted" marks an unfinished
    // draft complete. The student has already been told the load failed.
    expect(resolveResponseWriteFlags({ isSubmitted: false, loadedState: "unknown" })).toEqual({
      skip: true,
      isSubmitted: false,
      stampSubmittedAt: false
    });
  });

  test("Complete always submits and stamps submitted_at, whatever the loaded state", () => {
    for (const loadedState of ["draft", "submitted", "unknown"] as const) {
      expect(resolveResponseWriteFlags({ isSubmitted: true, loadedState })).toEqual({
        skip: false,
        isSubmitted: true,
        stampSubmittedAt: true
      });
    }
  });

  test("no combination can ever write is_submitted:false over a submitted row", () => {
    for (const isSubmitted of [true, false]) {
      const flags = resolveResponseWriteFlags({ isSubmitted, loadedState: "submitted" });
      expect(flags.skip || flags.isSubmitted).toBe(true);
    }
  });
});

describe("isSurveyResponseReadOnly", () => {
  test("a submitted response locks when the survey does not allow editing", () => {
    expect(
      isSurveyResponseReadOnly({ responseIsSubmitted: true, allowResponseEditing: false, isViewingAsStudent: false })
    ).toBe(true);
  });

  test("a submitted response stays editable when the survey allows editing", () => {
    expect(
      isSurveyResponseReadOnly({ responseIsSubmitted: true, allowResponseEditing: true, isViewingAsStudent: false })
    ).toBe(false);
  });

  test("an unsubmitted response is editable", () => {
    expect(
      isSurveyResponseReadOnly({ responseIsSubmitted: false, allowResponseEditing: false, isViewingAsStudent: false })
    ).toBe(false);
  });

  test("an instructor viewing as a student never gets a writable form", () => {
    expect(
      isSurveyResponseReadOnly({ responseIsSubmitted: false, allowResponseEditing: true, isViewingAsStudent: true })
    ).toBe(true);
  });
});

describe("loading a submitted response and then editing it (the reported data loss)", () => {
  // Walks the page's own sequence: load the row, derive read-only, then have SurveyJS fire a
  // value change that reaches the debounced autosave.
  const loadThenEdit = (row: { is_submitted: boolean }, allowResponseEditing: boolean) => {
    const loadedState = responseStateFromLoad({ data: row, error: null });
    const flags = resolveResponseWriteFlags({ isSubmitted: false, loadedState });
    return {
      readOnly: isSurveyResponseReadOnly({
        responseIsSubmitted: row.is_submitted,
        allowResponseEditing,
        isViewingAsStudent: false
      }),
      rowStaysSubmitted: flags.skip || flags.isSubmitted,
      submittedAtUnchanged: !flags.stampSubmittedAt,
      editPersisted: !flags.skip
    };
  };

  test("an editable survey keeps the form live and the autosaved edit keeps the row submitted", () => {
    // Before the fix the autosave wrote is_submitted:false here, so rowStaysSubmitted was false.
    expect(loadThenEdit({ is_submitted: true }, true)).toEqual({
      readOnly: false,
      rowStaysSubmitted: true,
      submittedAtUnchanged: true,
      editPersisted: true
    });
  });

  test("a non-editable survey is read-only once submitted", () => {
    expect(loadThenEdit({ is_submitted: true }, false).readOnly).toBe(true);
  });

  test("a draft response is editable and still autosaves as a draft", () => {
    const result = loadThenEdit({ is_submitted: false }, true);
    expect(result.readOnly).toBe(false);
    expect(result.rowStaysSubmitted).toBe(false);
    expect(result.editPersisted).toBe(true);
  });
});
