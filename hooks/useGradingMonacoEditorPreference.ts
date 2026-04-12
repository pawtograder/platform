"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useState } from "react";

/**
 * Loads and updates `public.users.use_monaco_grading_editor` for the signed-in user.
 * Defaults to true when the column is missing or null (matches DB default).
 */
export function useGradingMonacoEditorPreference() {
  const [useMonacoGradingEditor, setUseMonacoGradingEditor] = useState<boolean | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) {
      setUseMonacoGradingEditor(true);
      return;
    }
    const { data, error } = await supabase
      .from("users")
      .select("use_monaco_grading_editor")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      setUseMonacoGradingEditor(true);
      return;
    }
    const v = data?.use_monaco_grading_editor;
    setUseMonacoGradingEditor(typeof v === "boolean" ? v : true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const savePreference = useCallback(async (next: boolean) => {
    const supabase = createClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (!user) return;
    setIsSaving(true);
    const { error } = await supabase.from("users").update({ use_monaco_grading_editor: next }).eq("user_id", user.id);
    setIsSaving(false);
    if (error) {
      throw error;
    }
    setUseMonacoGradingEditor(next);
  }, []);

  return {
    useMonacoGradingEditor,
    setUseMonacoGradingEditor,
    savePreference,
    isSaving,
    reload: load
  };
}
