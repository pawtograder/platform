export const RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE =
  "You have unsaved rubric changes. Leave this page without saving?";

const STORAGE_KEY_PREFIX = "pawtograder:rubric-unsaved-changes";

const safeSessionStorage = {
  getItem(key: string): string | null {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // No-op in restricted browsing contexts
    }
  },
  removeItem(key: string): void {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // No-op in restricted browsing contexts
    }
  }
};

function getStorageKeyOrNull(assignmentId: string | number): string | null {
  const normalizedAssignmentId = String(assignmentId).trim();
  if (!normalizedAssignmentId) return null;
  return `${STORAGE_KEY_PREFIX}:${normalizedAssignmentId}`;
}

export function setRubricUnsavedChangesFlag(assignmentId: string | number, hasUnsavedChanges: boolean): void {
  const storageKey = getStorageKeyOrNull(assignmentId);
  if (!storageKey) return;

  if (hasUnsavedChanges) {
    safeSessionStorage.setItem(storageKey, "true");
    return;
  }
  safeSessionStorage.removeItem(storageKey);
}

export function hasRubricUnsavedChangesFlag(assignmentId: string | number): boolean {
  const storageKey = getStorageKeyOrNull(assignmentId);
  if (!storageKey) return false;
  return safeSessionStorage.getItem(storageKey) === "true";
}

export function clearRubricUnsavedChangesFlag(assignmentId: string | number): void {
  const storageKey = getStorageKeyOrNull(assignmentId);
  if (!storageKey) return;
  safeSessionStorage.removeItem(storageKey);
}
