import type { Json } from "@/utils/supabase/SupabaseTypes";

/**
 * Typed JSON stored in `public.users.preferences` (jsonb).
 * Add new top-level keys or nested sections here as the app grows.
 */
export type UserPreferencesGrading = {
  /** When true, submission file grading uses Monaco; when false, plain text (no Monaco bundle). */
  useMonacoEditor: boolean;
};

export type UserPreferences = {
  grading: UserPreferencesGrading;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  grading: {
    useMonacoEditor: true
  }
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeSection<T extends Record<string, unknown>>(base: T, patch: Partial<T> | undefined): T {
  if (patch === undefined) return base;
  return { ...base, ...patch };
}

/**
 * Merge partial updates into base preferences (per top-level section).
 * When adding a new section to `UserPreferences`, add one `mergeSection` line here.
 */
export function mergeUserPreferences(base: UserPreferences, patch: Partial<UserPreferences>): UserPreferences {
  return {
    ...base,
    grading: mergeSection(base.grading, patch.grading)
  };
}

/**
 * Parse jsonb from the database into `UserPreferences`, filling missing keys from defaults.
 */
export function parseUserPreferencesFromDb(stored: Json | null | undefined): UserPreferences {
  if (!isPlainObject(stored)) {
    return { ...DEFAULT_USER_PREFERENCES, grading: { ...DEFAULT_USER_PREFERENCES.grading } };
  }

  const gradingRaw = stored["grading"];
  const gradingObj = isPlainObject(gradingRaw) ? gradingRaw : {};

  const useMonaco = gradingObj["useMonacoEditor"];
  const useMonacoEditor = typeof useMonaco === "boolean" ? useMonaco : DEFAULT_USER_PREFERENCES.grading.useMonacoEditor;

  return {
    grading: {
      ...DEFAULT_USER_PREFERENCES.grading,
      useMonacoEditor
    }
  };
}
