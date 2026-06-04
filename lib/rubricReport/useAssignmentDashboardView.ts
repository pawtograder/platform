"use client";

import { createClient } from "@/utils/supabase/client";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { useCallback, useEffect, useState } from "react";
import type { RubricFilter } from "./filterSchema";

export type DashboardViz = "bars" | "options" | "table" | "section";

/** The persisted, shared rubric-report view config for an assignment. */
export type DashboardViewConfig = {
  viz: DashboardViz;
  filter?: RubricFilter | null;
};

export type SavedDashboardView = {
  config: DashboardViewConfig;
  updatedAt: string;
  savedByName: string | null;
};

export type UseAssignmentDashboardViewResult = {
  /** The saved shared default, or null if none has been saved yet. */
  saved: SavedDashboardView | null;
  isLoading: boolean;
  error: string | null;
  /** Persist `config` as the assignment's shared default (instructor-only, enforced by RLS). */
  save: (config: DashboardViewConfig) => Promise<{ ok: boolean; error?: string }>;
  reload: () => void;
};

/**
 * Load and persist the per-assignment SHARED dashboard view (rubric-report filter +
 * visualization). Saving updates the default for all staff; the trigger validates the
 * config and stamps updated_by/updated_at. Reads are gated to staff by RLS.
 */
export function useAssignmentDashboardView(assignmentId: number | undefined): UseAssignmentDashboardViewResult {
  const [saved, setSaved] = useState<SavedDashboardView | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assignmentId) return;
    setIsLoading(true);
    setError(null);
    const supabase = createClient();
    const { data, error: selErr } = await supabase
      .from("assignment_dashboard_views")
      .select("config, updated_at, updated_by")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    if (selErr) {
      setError(selErr.message);
      setIsLoading(false);
      return;
    }
    if (!data) {
      setSaved(null);
      setIsLoading(false);
      return;
    }
    let savedByName: string | null = null;
    if (data.updated_by) {
      const { data: profile } = await supabase.from("profiles").select("name").eq("id", data.updated_by).maybeSingle();
      savedByName = profile?.name ?? null;
    }
    setSaved({
      config: data.config as unknown as DashboardViewConfig,
      updatedAt: data.updated_at,
      savedByName
    });
    setIsLoading(false);
  }, [assignmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (config: DashboardViewConfig): Promise<{ ok: boolean; error?: string }> => {
      if (!assignmentId) return { ok: false, error: "No assignment" };
      const supabase = createClient();
      const { error: upsertErr } = await supabase
        .from("assignment_dashboard_views")
        .upsert({ assignment_id: assignmentId, config: config as unknown as Json }, { onConflict: "assignment_id" });
      if (upsertErr) return { ok: false, error: upsertErr.message };
      await load();
      return { ok: true };
    },
    [assignmentId, load]
  );

  return { saved, isLoading, error, save, reload: load };
}
