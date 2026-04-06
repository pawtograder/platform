"use client";

import { createContext, useContext } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";

export type CourseDataContextValue = {
  courseId: number;
  role: Database["public"]["Enums"]["app_role"];
  userId: string;
  profileId: string | null;
  supabase: SupabaseClient<Database>;
  classRtc: PawtograderRealTimeController | null;
  isStaff: boolean;
};

const CourseDataContext = createContext<CourseDataContextValue | null>(null);

export function useCourseDataContext(): CourseDataContextValue {
  const ctx = useContext(CourseDataContext);
  if (!ctx) throw new Error("useCourseDataContext must be used within CourseDataProvider");
  return ctx;
}

export const CourseDataProvider = CourseDataContext.Provider;
