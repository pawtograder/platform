"use client";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import { HydratedRubric, HydratedRubricCheck, RubricCheckReference } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useDelete, useInvalidate, useList } from "@refinedev/core";
import { useMemo } from "react";
import { FaLink, FaTrash } from "react-icons/fa";

type RubricReferencesProps = {
  currentRubric: HydratedRubric;
  assignmentId: number;
  classId: number;
};

const RubricReferencesSkeleton = () => (
  <VStack gap={3} align="stretch">
    <HStack>
      <Skeleton height="4" width="4" />
      <Skeleton height="4" width="200px" />
    </HStack>

    {Array.from({ length: 2 }).map((_, index) => (
      <Box key={index} p={3} bg="bg.subtle" borderRadius="md" border="1px solid" borderColor="border.emphasized">
        <VStack align="stretch" gap={2}>
          <HStack justifyContent="space-between" align="flex-start">
            <VStack align="stretch" gap={1} flex="1">
              <SkeletonText noOfLines={1} />
              <Skeleton height="3" width="80px" />

              <Skeleton height="4" width="150px" mt={2} />
              <SkeletonText noOfLines={3} />
            </VStack>

            <Skeleton height="8" width="8" />
          </HStack>
        </VStack>
      </Box>
    ))}
  </VStack>
);

// Component that handles the actual data fetching and rendering
function RubricReferencesContent({ currentRubric, assignmentId, classId }: RubricReferencesProps) {
  // Get all checks from the current rubric
  const currentRubricChecks = useMemo(() => {
    return currentRubric.rubric_parts.flatMap((part) =>
      part.rubric_criteria.flatMap((criteria) => criteria.rubric_checks)
    );
  }, [currentRubric]);

  const currentRubricCheckIds = useMemo(() => {
    return currentRubricChecks.map((check) => check.id);
  }, [currentRubricChecks]);

  // Fetch all reference relationships where a check from current rubric is referencing another check
  const { data: referencesData, isLoading: isLoadingReferences } = useList<RubricCheckReference>({
    resource: "rubric_check_references",
    filters:
      currentRubricCheckIds.length > 0
        ? [
            { field: "referencing_rubric_check_id", operator: "in", value: currentRubricCheckIds },
            { field: "class_id", operator: "eq", value: classId }
          ]
        : [
            { field: "class_id", operator: "eq", value: classId },
            { field: "referencing_rubric_check_id", operator: "in", value: [-1] } // Never matches, but valid query
          ],
    queryOptions: {
      enabled: true // Use filters to actually control results
    }
  });

  // Fetch referenced checks details
  const referencedCheckIds = useMemo(() => {
    return referencesData?.data?.map((ref) => ref.referenced_rubric_check_id) || [];
  }, [referencesData]);

  const { data: referencedChecksData, isLoading: isLoadingReferencedChecks } = useList<HydratedRubricCheck>({
    resource: "rubric_checks",
    filters: [{ field: "id", operator: "in", value: referencedCheckIds }],
    queryOptions: {
      enabled: referencedCheckIds.length > 0
    }
  });

  // Fetch rubrics for the referenced checks to get their context
  const { data: allRubricsData, isLoading: isLoadingRubrics } = useList<HydratedRubric>({
    resource: "rubrics",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    meta: {
      select: "id, name, review_round, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))"
    },
    queryOptions: {
      enabled: referencedCheckIds.length > 0
    }
  });

  // Build display data
  const referenceDisplayData = useMemo(() => {
    if (!referencesData?.data || !referencedChecksData?.data || !allRubricsData?.data) {
      return [];
    }

    return referencesData.data.map((reference) => {
      const referencingCheck = currentRubricChecks.find((check) => check.id === reference.referencing_rubric_check_id);
      const referencedCheck = referencedChecksData.data.find(
        (check) => check.id === reference.referenced_rubric_check_id
      );

      // Find which rubric contains the referenced check
      let referencedRubric: HydratedRubric | undefined;
      let referencedCriteria: string | undefined;

      if (referencedCheck) {
        for (const rubric of allRubricsData.data) {
          for (const part of rubric.rubric_parts) {
            for (const criteria of part.rubric_criteria) {
              if (criteria.rubric_checks.some((check) => check.id === referencedCheck.id)) {
                referencedRubric = rubric;
                referencedCriteria = criteria.name;
                break;
              }
            }
            if (referencedRubric) break;
          }
          if (referencedRubric) break;
        }
      }

      return {
        reference,
        referencingCheck,
        referencedCheck,
        referencedRubric,
        referencedCriteria
      };
    });
  }, [referencesData, referencedChecksData, allRubricsData, currentRubricChecks]);

  const { mutate: deleteReference } = useDelete();
  const invalidate = useInvalidate();

  // Check if we have any checks to work with first
  if (currentRubricCheckIds.length === 0) {
    return (
      <Box p={4} bg="bg.muted" borderRadius="md" border="1px solid" borderColor="border.subtle">
        <Text fontSize="sm" color="fg.muted" textAlign="center">
          No checks found in this rubric to create references from.
        </Text>
      </Box>
    );
  }

  // Handle loading states properly
  if (isLoadingReferences) {
    return <RubricReferencesSkeleton />;
  }

  // Early return if no references found
  if (!referencesData?.data || referencesData.data.length === 0) {
    return (
      <Box p={4} bg="bg.muted" borderRadius="md" border="1px solid" borderColor="border.subtle">
        <Text fontSize="sm" color="fg.muted" textAlign="center">
          No references found for this rubric. Use the &quot;Reference Check&quot; button to create references to other
          rubric checks.
        </Text>
      </Box>
    );
  }

  // If we have references but still loading dependent data, show skeleton
  if (isLoadingReferencedChecks || isLoadingRubrics) {
    return <RubricReferencesSkeleton />;
  }

  const handleDeleteReference = (referenceId: number) => {
    deleteReference(
      {
        resource: "rubric_check_references",
        id: referenceId
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Reference Deleted",
            description: "The rubric check reference has been deleted successfully.",
            type: "success"
          });
          // Invalidate the rubric_check_references queries to trigger refetch
          invalidate({
            resource: "rubric_check_references",
            invalidates: ["list"]
          });
        },
        onError: (error) => {
          toaster.create({
            title: "Error Deleting Reference",
            description: error.message,
            type: "error"
          });
        }
      }
    );
  };

  return (
    <VStack gap={3} mx={2} align="stretch">
      <HStack>
        <Icon as={FaLink} />
        <Text fontSize="md" fontWeight="semibold">
          Rubric Check References ({referenceDisplayData.length})
        </Text>
      </HStack>

      {referenceDisplayData.map(
        ({ reference, referencingCheck, referencedCheck, referencedRubric, referencedCriteria }) => (
          <Box
            key={reference.id}
            p={3}
            bg="bg.subtle"
            borderRadius="md"
            border="1px solid"
            borderColor="border.emphasized"
          >
            <VStack align="stretch" gap={2}>
              <HStack justifyContent="space-between" align="flex-start">
                <VStack align="stretch" gap={1} flex="1">
                  <Text fontSize="sm" fontWeight="medium">
                    <strong>From this rubric:</strong> {referencingCheck?.name || "Unknown Check"}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Points: {referencingCheck?.points || 0}
                  </Text>

                  <Text fontSize="sm" fontWeight="medium" mt={2}>
                    <strong>References:</strong> {referencedCheck?.name || "Unknown Check"}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    From: {referencedRubric?.name || "Unknown Rubric"}
                    {referencedRubric?.review_round && ` (${referencedRubric.review_round})`}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Criteria: {referencedCriteria || "Unknown Criteria"}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Points: {referencedCheck?.points || 0}
                  </Text>
                </VStack>

                <Button
                  variant="ghost"
                  colorPalette="red"
                  size="sm"
                  onClick={() => handleDeleteReference(reference.id)}
                >
                  <Icon as={FaTrash} />
                </Button>
              </HStack>
            </VStack>
          </Box>
        )
      )}
    </VStack>
  );
}

// Main component
export default function RubricReferences(props: RubricReferencesProps) {
  return <RubricReferencesContent {...props} />;
}
