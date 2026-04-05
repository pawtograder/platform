"use client";

import { createContext, useContext } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";
import type { AssignmentControllerInitialData } from "@/lib/ssrUtils";

export type AssignmentDataContextValue = {
  assignmentId: number;
  courseId: number;
  profileId: string | null;
  supabase: SupabaseClient<Database>;
  classRtc: PawtograderRealTimeController | null;
  isStaff: boolean;
  initialData?: AssignmentControllerInitialData;
};

const AssignmentDataContext = createContext<AssignmentDataContextValue | null>(null);

export function useAssignmentDataContext(): AssignmentDataContextValue {
  const ctx = useContext(AssignmentDataContext);
  if (!ctx) throw new Error("useAssignmentDataContext must be used within AssignmentDataProvider");
  return ctx;
}

export const AssignmentDataProvider = AssignmentDataContext.Provider;
