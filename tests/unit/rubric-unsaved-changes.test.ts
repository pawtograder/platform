import {
  clearRubricUnsavedChangesFlag,
  hasRubricUnsavedChangesFlag,
  setRubricUnsavedChangesFlag
} from "@/lib/rubricUnsavedChanges";

describe("rubric unsaved changes session state", () => {
  const assignmentId = "123";

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("sets and reads unsaved state", () => {
    setRubricUnsavedChangesFlag(assignmentId, true);
    expect(hasRubricUnsavedChangesFlag(assignmentId)).toBe(true);
  });

  it("clears unsaved state when set false", () => {
    setRubricUnsavedChangesFlag(assignmentId, true);
    setRubricUnsavedChangesFlag(assignmentId, false);
    expect(hasRubricUnsavedChangesFlag(assignmentId)).toBe(false);
  });

  it("clears unsaved state explicitly", () => {
    setRubricUnsavedChangesFlag(assignmentId, true);
    clearRubricUnsavedChangesFlag(assignmentId);
    expect(hasRubricUnsavedChangesFlag(assignmentId)).toBe(false);
  });

  it("ignores empty assignment ids", () => {
    setRubricUnsavedChangesFlag("", true);
    expect(hasRubricUnsavedChangesFlag("")).toBe(false);
  });
});
