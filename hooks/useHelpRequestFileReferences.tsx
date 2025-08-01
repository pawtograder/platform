"use client";

import { useState, useEffect, useMemo } from "react";
import { useOfficeHoursController } from "./useOfficeHoursRealtime";
import type { HelpRequestFileReference } from "@/utils/supabase/DatabaseTypes";

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
  const controller = useOfficeHoursController();
  const [allFileReferences, setAllFileReferences] = useState<HelpRequestFileReference[]>([]);

  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestFileReferences.list((data) => {
      setAllFileReferences(data);
    });
    setAllFileReferences(data);
    return unsubscribe;
  }, [controller]);

  // Filter by help request ID if provided
  const fileReferences = useMemo(() => {
    if (!helpRequestId) {
      return allFileReferences;
    }
    return allFileReferences.filter((ref) => ref.help_request_id === helpRequestId);
  }, [allFileReferences, helpRequestId]);

  return {
    fileReferences,
    isLoading: !controller.isReady
  };
}
