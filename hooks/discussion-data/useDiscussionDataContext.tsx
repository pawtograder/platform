"use client";

import { createContext, useContext } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";

export type DiscussionDataContextValue = {
  rootThreadId: number;
  courseId: number;
  supabase: SupabaseClient<Database>;
  classRtc: PawtograderRealTimeController | null;
};

const DiscussionDataContext = createContext<DiscussionDataContextValue | null>(null);

export function useDiscussionDataContext(): DiscussionDataContextValue {
  const ctx = useContext(DiscussionDataContext);
  if (!ctx) throw new Error("useDiscussionDataContext must be used within DiscussionDataProvider");
  return ctx;
}

export const DiscussionDataProvider = DiscussionDataContext.Provider;
