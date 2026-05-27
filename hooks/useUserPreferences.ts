"use client";

import {
  DEFAULT_USER_PREFERENCES,
  mergeUserPreferences,
  parseUserPreferencesFromDb,
  type UserPreferences
} from "@/types/UserPreferences";
import { createClient } from "@/utils/supabase/client";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { useCallback, useEffect, useState } from "react";

export type UseUserPreferencesResult = {
  preferences: UserPreferences | undefined;
  /** Replace entire preferences (use sparingly). */
  setPreferences: (next: UserPreferences) => void;
  /** Deep-merge a partial update and persist. */
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  isSaving: boolean;
  reload: () => Promise<void>;
};

/**
 * Loads and updates `public.users.preferences` (jsonb) for the signed-in user.
 * Merges with `DEFAULT_USER_PREFERENCES` so new keys get safe defaults.
 */
export function useUserPreferences(): UseUserPreferencesResult {
  const [preferences, setPreferencesState] = useState<UserPreferences | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) {
      setPreferencesState({
        ...DEFAULT_USER_PREFERENCES,
        grading: { ...DEFAULT_USER_PREFERENCES.grading }
      });
      return;
    }
    const { data, error } = await supabase.from("users").select("preferences").eq("user_id", user.id).maybeSingle();
    if (error) {
      setPreferencesState({
        ...DEFAULT_USER_PREFERENCES,
        grading: { ...DEFAULT_USER_PREFERENCES.grading }
      });
      return;
    }
    setPreferencesState(parseUserPreferencesFromDb(data?.preferences as Json | null | undefined));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setPreferences = useCallback((next: UserPreferences) => {
    setPreferencesState(next);
  }, []);

  const updatePreferences = useCallback(async (patch: Partial<UserPreferences>) => {
    const supabase = createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) return;

    setIsSaving(true);
    try {
      const { data: row, error: fetchError } = await supabase
        .from("users")
        .select("preferences")
        .eq("user_id", user.id)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      const current = parseUserPreferencesFromDb(row?.preferences as Json | null | undefined);
      const merged = mergeUserPreferences(current, patch);
      const payload = merged as unknown as Json;

      const { error: updateError } = await supabase
        .from("users")
        .update({ preferences: payload })
        .eq("user_id", user.id);

      if (updateError) {
        throw updateError;
      }

      setPreferencesState(merged);
    } finally {
      setIsSaving(false);
    }
  }, []);

  return {
    preferences,
    setPreferences,
    updatePreferences,
    isSaving,
    reload: load
  };
}
