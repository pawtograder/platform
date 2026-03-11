"use client";
import { createContext, useContext } from "react";

export const TargetStudentContext = createContext<string | null>(null);

export function useTargetStudentProfileId() {
  return useContext(TargetStudentContext);
}
