import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { ClassSection, LabSection, RubricPart, Tag } from "@/utils/supabase/DatabaseTypes";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@chakra-ui/react";
import { HStack, Text, VStack } from "@chakra-ui/react";
import { MultiValue } from "chakra-react-select";
import { useMemo, useState } from "react";
import * as Sentry from "@sentry/nextjs";

interface ClearAssignmentsButtonProps {
  selectedRubric?: { id: number; name: string };
  selectedRubricPartsForFilter: MultiValue<{ label: string; value: RubricPart }>;
  selectedClassSections: MultiValue<{ label: string; value: ClassSection }>;
  selectedLabSections: MultiValue<{ label: string; value: LabSection }>;
  selectedStudentTags: MultiValue<{ label: string; value: Tag }>;
  submissionsToDo: { id: number; profile_id?: string | null; assignment_group_id?: number | null }[] | undefined;
  course_id: string | string[];
  assignment_id: string | string[];
  onSuccess: () => void;
  disabled?: boolean;
}

export default function ClearAssignmentsButton({
  selectedRubric,
  selectedRubricPartsForFilter,
  selectedClassSections,
  selectedLabSections,
  selectedStudentTags,
  submissionsToDo,
  course_id,
  assignment_id,
  onSuccess,
  disabled = false
}: ClearAssignmentsButtonProps) {
  const supabase = createClient();
  const [isOpen, setIsOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // Calculate the number of submissions that match the current filters
  const matchingSubmissionsCount = useMemo(() => {
    if (!submissionsToDo || !selectedRubric) return 0;
    return submissionsToDo.length;
  }, [submissionsToDo, selectedRubric]);

  const clearUnfinishedAssignments = async () => {
    setIsClearing(true);
    try {
      if (!selectedRubric) {
        toaster.error({ title: "Error", description: "No rubric selected" });
        return false;
      } else if (!course_id) {
        toaster.error({ title: "Error", description: "Failed to find current course" });
        return false;
      }

      // Build filter description for logging and user feedback
      const filters = [];
      if (selectedRubricPartsForFilter.length > 0) {
        filters.push(`rubric parts: ${selectedRubricPartsForFilter.map((p) => p.value.name).join(", ")}`);
      }
      if (selectedClassSections.length > 0) {
        filters.push(`class sections: ${selectedClassSections.map((s) => s.value.name).join(", ")}`);
      }
      if (selectedLabSections.length > 0) {
        filters.push(`lab sections: ${selectedLabSections.map((s) => s.value.name).join(", ")}`);
      }
      if (selectedStudentTags.length > 0) {
        filters.push(`student tags: ${selectedStudentTags.map((t) => t.value.name).join(", ")}`);
      }

      // Add Sentry breadcrumb for tracking
      Sentry.addBreadcrumb({
        message: "Starting clear unfinished assignments with filters",
        category: "clear_assignments",
        data: {
          course_id: Number(course_id),
          assignment_id: Number(assignment_id),
          rubric_id: selectedRubric.id,
          matching_submissions: matchingSubmissionsCount,
          filters: filters
        },
        level: "info"
      });

      // Prepare rubric parts filter
      const rubricPartIds =
        selectedRubricPartsForFilter.length === 0
          ? null // No filter - clear all parts
          : selectedRubricPartsForFilter.map((part) => part.value.id);

      // Prepare additional filters
      const classSectionIds =
        selectedClassSections.length === 0 ? null : selectedClassSections.map((section) => section.value.id);

      const labSectionIds =
        selectedLabSections.length === 0 ? null : selectedLabSections.map((section) => section.value.id);

      const studentTagFilters =
        selectedStudentTags.length === 0
          ? null
          : selectedStudentTags.map((tag) => ({ name: tag.value.name, color: tag.value.color }));

      // Call the clear_unfinished_review_assignments RPC
      const { data: result, error: rpcError } = await supabase.rpc("clear_unfinished_review_assignments", {
        p_class_id: Number(course_id),
        p_assignment_id: Number(assignment_id),
        p_rubric_id: selectedRubric.id,
        p_rubric_part_ids: rubricPartIds ?? undefined,
        p_class_section_ids: classSectionIds ?? undefined,
        p_lab_section_ids: labSectionIds ?? undefined,
        p_student_tag_filters: studentTagFilters
      });

      if (rpcError) {
        Sentry.withScope((scope) => {
          scope.setContext("clear_assignments", {
            error: rpcError.message,
            code: rpcError.code
          });
          Sentry.captureException(rpcError);
        });

        toaster.error({
          title: "Error clearing assignments",
          description: rpcError.message || "Failed to clear unfinished assignments"
        });
        return false;
      }

      // Type cast the result for proper access to properties
      const typedResult = result as {
        success: boolean;
        error?: string;
        assignments_deleted: number;
        parts_deleted: number;
        message?: string;
      };

      if (!typedResult?.success) {
        Sentry.withScope((scope) => {
          scope.setContext("clear_assignments", {
            result: typedResult
          });
          Sentry.captureException(
            new Error(`Clear assignments RPC returned failure: ${typedResult?.error || "Unknown error"}`)
          );
        });

        toaster.error({
          title: "Error clearing assignments",
          description: typedResult?.error || "Unknown error occurred while clearing assignments"
        });
        return false;
      }

      // Log successful operation
      Sentry.addBreadcrumb({
        message: "Clear assignments completed successfully",
        category: "clear_assignments",
        data: {
          assignments_deleted: typedResult.assignments_deleted,
          parts_deleted: typedResult.parts_deleted
        },
        level: "info"
      });

      // Show success message
      if (typedResult.assignments_deleted === 0) {
        const filterDescription = filters.length === 0 ? "the current filters" : filters.join(", ");
        toaster.create({
          title: "No Assignments to Clear",
          description: `No unfinished review assignments were found for ${filterDescription}`,
          type: "info"
        });
      } else {
        const filterDescription = filters.length === 0 ? "" : ` (filtered by: ${filters.join(", ")})`;
        toaster.success({
          title: "Assignments Cleared",
          description: `Cleared ${typedResult.assignments_deleted} unfinished assignments${filterDescription}`
        });
      }

      onSuccess();
      setIsOpen(false);
      return true;
    } catch (e: unknown) {
      const errMsg =
        (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : undefined) ||
        "An unexpected error occurred while clearing assignments";

      Sentry.captureException(e);

      toaster.error({
        title: "Error clearing assignments",
        description: errMsg
      });
      return false;
    } finally {
      setIsClearing(false);
    }
  };

  const buttonText = useMemo(() => {
    if (matchingSubmissionsCount === 0) {
      return "No Matching Unfinished Assignments to Clear";
    }

    const submissionText = `${matchingSubmissionsCount} submission${matchingSubmissionsCount === 1 ? "" : "s"}`;

    if (selectedRubricPartsForFilter.length === 0) {
      // No specific parts selected - clearing whole rubric
      return `Clear Unfinished Assignments from ${submissionText}`;
    } else {
      // Specific parts selected
      const partsCount = selectedRubricPartsForFilter.length;
      const partsText = `${partsCount} rubric part${partsCount === 1 ? "" : "s"}`;
      return `Clear Unfinished Assignments from ${submissionText}, ${partsText}`;
    }
  }, [matchingSubmissionsCount, selectedRubricPartsForFilter]);

  const confirmationText = useMemo(() => {
    if (matchingSubmissionsCount === 0) {
      return "No assignments to clear with current filters.";
    }

    const submissionText = `${matchingSubmissionsCount} submission${matchingSubmissionsCount === 1 ? "" : "s"}`;
    const partsText =
      selectedRubricPartsForFilter.length === 0
        ? "all rubric parts"
        : `${selectedRubricPartsForFilter.length} selected rubric part${selectedRubricPartsForFilter.length === 1 ? "" : "s"}`;

    return `This will clear all unfinished assignments from ${submissionText} for ${partsText}. This action cannot be undone.`;
  }, [matchingSubmissionsCount, selectedRubricPartsForFilter]);

  return (
    <PopoverRoot open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <PopoverTrigger asChild>
        <Button
          maxWidth={"md"}
          variant="outline"
          colorPalette="red"
          disabled={disabled || !selectedRubric || matchingSubmissionsCount === 0}
        >
          {buttonText}
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverArrow />
        <PopoverBody>
          <VStack gap={3} align="stretch">
            <Text fontSize="sm" fontWeight="medium">
              Confirm Clear Assignments
            </Text>
            <Text fontSize="sm" color="text.muted">
              {confirmationText}
            </Text>
            <HStack gap={2} justify="flex-end">
              <Button size="sm" variant="outline" onClick={() => setIsOpen(false)} disabled={isClearing}>
                Cancel
              </Button>
              <Button size="sm" colorPalette="red" onClick={clearUnfinishedAssignments} loading={isClearing}>
                Clear Assignments
              </Button>
            </HStack>
          </VStack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
