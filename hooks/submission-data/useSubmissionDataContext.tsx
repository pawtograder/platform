"use client";

import { createContext, useContext } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";

export type SubmissionDataContextValue = {
  submissionId: number;
  courseId: number;
  supabase: SupabaseClient<Database>;
  classRtc: PawtograderRealTimeController | null;
};

const SubmissionDataContext = createContext<SubmissionDataContextValue | null>(null);

export function useSubmissionDataContext(): SubmissionDataContextValue {
  const ctx = useContext(SubmissionDataContext);
  if (!ctx) throw new Error("useSubmissionDataContext must be used within SubmissionDataProvider");
  return ctx;
}

/**
 * Like useSubmissionDataContext, but returns null instead of throwing
 * when there is no SubmissionDataProvider. Useful for hooks that may
 * be called from components that optionally render inside a SubmissionProvider.
 */
export function useSubmissionDataContextMaybe(): SubmissionDataContextValue | null {
  return useContext(SubmissionDataContext);
}

export const SubmissionDataProvider = SubmissionDataContext.Provider;
