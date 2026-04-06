"use client";

import { useMemo } from "react";
import type { HelpRequestFileReference } from "@/utils/supabase/DatabaseTypes";
import { useHelpRequestFileReferencesQuery } from "@/hooks/office-hours-data";

export interface UseHelpRequestFileReferencesReturn {
  // File references data
  fileReferences: HelpRequestFileReference[];

  // Loading state
  isLoading: boolean;
}

/**
 * Hook for accessing help request file references with real-time updates.
 * Can be used to get all file references or filter by help request ID.
 *
 * This hook replaces the file reference functionality from useOfficeHoursRealtime.
 */
export function useHelpRequestFileReferences(helpRequestId?: number): UseHelpRequestFileReferencesReturn {
  const { data: allFileReferences = [], isLoading } = useHelpRequestFileReferencesQuery();

  // Filter by help request ID if provided
  const fileReferences = useMemo(() => {
    if (!helpRequestId) {
      return allFileReferences;
    }
    return allFileReferences.filter((ref) => ref.help_request_id === helpRequestId);
  }, [allFileReferences, helpRequestId]);

  return {
    fileReferences,
    isLoading
  };
}
