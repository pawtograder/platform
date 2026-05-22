"use client";
import { Box, HStack, Icon, Text } from "@chakra-ui/react";
import { FaInfo } from "react-icons/fa";

import { ErrorPinCallout } from "@/components/discussion/ErrorPinCallout";
import { AIHelpSubmissionErrorButton } from "@/components/ai-help/AIHelpSubmissionErrorButton";

export function GenericBuildError({
  errorPinMatches,
  buildOutput,
  assignmentId,
  classId,
  submissionId
}: {
  errorPinMatches?: Map<number | null, import("@/hooks/useErrorPinMatches").ErrorPinMatch[]>;
  buildOutput?: string;
  assignmentId: number;
  classId: number;
  submissionId: number;
}) {
  // Get all matches (both submission-level and test-level) for build errors
  const allMatches: import("@/hooks/useErrorPinMatches").ErrorPinMatch[] = [];
  if (errorPinMatches) {
    errorPinMatches.forEach((matches) => {
      allMatches.push(...matches);
    });
  }
  // Deduplicate by error_pin_id
  const uniqueMatches = allMatches.filter(
    (match, index, self) => index === self.findIndex((m) => m.error_pin_id === match.error_pin_id)
  );

  return (
    <Box mt={3}>
      <Box p={3} bg="bg.error" borderRadius="md" border="1px solid" borderColor="border.error">
        <HStack justify="space-between">
          <Text fontWeight="bold" color="fg.error" fontSize="sm">
            Error: Gradle build failed
          </Text>
          {buildOutput && (
            <AIHelpSubmissionErrorButton
              errorType="build_error"
              errorOutput={buildOutput}
              assignmentId={assignmentId}
              classId={classId}
              submissionId={submissionId}
            />
          )}
        </HStack>
        <Box mt={2} p={2} bg="bg.error" borderRadius="sm">
          <Text color="fg.error">
            The autograding script failed to build your code. Please inspect the output below for more details:
          </Text>
        </Box>
      </Box>
      {/* Show error pins very prominently for build errors */}
      {uniqueMatches.length > 0 && (
        <Box
          mt={4}
          p={4}
          bg="blue.50"
          borderRadius="lg"
          border="2px solid"
          borderColor="blue.400"
          _dark={{ bg: "blue.900", borderColor: "blue.500" }}
        >
          <HStack gap={3} align="flex-start">
            <Icon fontSize="2xl" color="blue.500" mt={1}>
              <FaInfo />
            </Icon>
            <Box flex="1">
              <Text fontWeight="bold" fontSize="lg" color="blue.700" _dark={{ color: "blue.200" }} mb={2}>
                Troubleshooting Help Available
              </Text>
              <Text fontSize="md" color="blue.600" _dark={{ color: "blue.300" }} mb={3}>
                Your build error matches common issues that have been discussed. Check out posts that instructors think
                will help you:
              </Text>
              <ErrorPinCallout matches={uniqueMatches} linksOnly />
            </Box>
          </HStack>
        </Box>
      )}
    </Box>
  );
}
