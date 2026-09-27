/* eslint-disable @typescript-eslint/no-explicit-any */
export function useUserPreferences(): any {
  return { preferences: { grading: { useMonacoEditor: false } }, updatePreferences: async () => {}, isSaving: false };
}
