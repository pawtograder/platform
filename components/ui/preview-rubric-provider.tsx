"use client";

import { createPreviewAssignmentController } from "@/lib/PreviewAssignmentController";
import { AssignmentContext, useAssignmentController } from "@/hooks/useAssignment";
import { HydratedRubric } from "@/utils/supabase/DatabaseTypes";
import { useMemo, useRef } from "react";

interface PreviewRubricProviderProps {
  rubricData: HydratedRubric;
  children: React.ReactNode;
}

/**
 * Provides preview rubric data through the AssignmentController context.
 *
 * Wraps children with a specialized AssignmentController that returns
 * preview data for rubric queries while maintaining access to other
 * assignment data (submissions, review assignments, etc).
 *
 * Usage:
 * ```tsx
 * <PreviewRubricProvider rubricData={parsedRubric}>
 *   <RubricSidebar rubricId={parsedRubric.id} />
 * </PreviewRubricProvider>
 * ```
 */
export function PreviewRubricProvider({ rubricData, children }: PreviewRubricProviderProps) {
  const baseController = useAssignmentController();

  // Serialize rubricData for stable comparison
  const rubricDataString = useMemo(() => JSON.stringify(rubricData), [rubricData]);

  // Keep refs to avoid recreating controller unnecessarily
  const controllerRef = useRef<ReturnType<typeof createPreviewAssignmentController>>();
  const lastRubricDataString = useRef<string>();
  const lastBaseController = useRef<typeof baseController>();

  const previewController = useMemo(() => {
    // Recreate if either the baseController identity or rubric data changed
    const baseControllerChanged = lastBaseController.current !== baseController;
    const rubricDataChanged = lastRubricDataString.current !== rubricDataString;
    
    if (baseControllerChanged || rubricDataChanged) {
      lastBaseController.current = baseController;
      lastRubricDataString.current = rubricDataString;
      controllerRef.current = createPreviewAssignmentController(baseController, rubricData);
    }
    return controllerRef.current!;
  }, [baseController, rubricData, rubricDataString]);

  return (
    <AssignmentContext.Provider value={{ assignmentController: previewController }}>
      {children}
    </AssignmentContext.Provider>
  );
}
