export const RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE =
  "You have unsaved rubric changes. Leave this page without saving?";

const STORAGE_KEY_PREFIX = "pawtograder:rubric-unsaved-changes";

function getStorageKeyOrNull(assignmentId: string | number): string | null {
  const normalizedAssignmentId = String(assignmentId).trim();
  if (!normalizedAssignmentId) return null;
  return `${STORAGE_KEY_PREFIX}:${normalizedAssignmentId}`;
}

export function setRubricUnsavedChangesFlag(assignmentId: string | number, hasUnsavedChanges: boolean): void {
  if (typeof window === "undefined") return;
  const storageKey = getStorageKeyOrNull(assignmentId);
  if (!storageKey) return;

  if (hasUnsavedChanges) {
    window.sessionStorage.setItem(storageKey, "true");
    return;
  }
  window.sessionStorage.removeItem(storageKey);
}

export function hasRubricUnsavedChangesFlag(assignmentId: string | number): boolean {
  if (typeof window === "undefined") return false;
  const storageKey = getStorageKeyOrNull(assignmentId);
  if (!storageKey) return false;
  return window.sessionStorage.getItem(storageKey) === "true";
}

export function clearRubricUnsavedChangesFlag(assignmentId: string | number): void {
  if (typeof window === "undefined") return;
  const storageKey = getStorageKeyOrNull(assignmentId);
  if (!storageKey) return;
  window.sessionStorage.removeItem(storageKey);
}
