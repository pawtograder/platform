"use client";

import { createContext, useContext } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";

export type OfficeHoursDataContextValue = {
  classId: number;
  supabase: SupabaseClient<Database>;
  classRtc: PawtograderRealTimeController | null;
  /** The office hours RT controller provides additional channels */
  officeHoursRtc: PawtograderRealTimeController | null;
};

const OfficeHoursDataContext = createContext<OfficeHoursDataContextValue | null>(null);

export function useOfficeHoursDataContext(): OfficeHoursDataContextValue {
  const ctx = useContext(OfficeHoursDataContext);
  if (!ctx) throw new Error("useOfficeHoursDataContext must be used within OfficeHoursDataProvider");
  return ctx;
}

export const OfficeHoursDataProvider = OfficeHoursDataContext.Provider;
