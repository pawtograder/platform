"use client";

import { Box, Heading, Text, VStack, HStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { useParams } from "next/navigation";
import { useActiveLivePolls } from "@/hooks/useCourseController";
import StudentPollsTable from "./StudentPollsTable";

export default function StudentPollsPage() {
  const { course_id } = useParams();
  const { polls, isLoading } = useActiveLivePolls();

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");

  const handlePollClick = () => {
    window.open(`/poll/${course_id}`, "_blank");
  };

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        {/* Header */}
        {!isLoading && (
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="center">
              <VStack align="start" gap={2} flex={1}>
                <Heading size="xl" color={textColor} textAlign="left">
                  Live Polls
                </Heading>
                <Text color={textColor} fontSize="md" opacity={0.8}>
                  Participate in live polls for this course.
                </Text>
              </VStack>
              {/* Refresh button no longer needed - data updates in real-time */}
            </HStack>
          </VStack>
        )}

        {/* Content */}
        {isLoading ? (
          <Box display="flex" alignItems="center" justifyContent="center" p={8}>
            <Text>Loading polls...</Text>
          </Box>
        ) : polls.length === 0 ? (
          <Box display="flex" justifyContent="center" w="100%">
            <Box
              maxW="800px"
              w="100%"
              bg={cardBgColor}
              border="1px solid"
              borderColor={borderColor}
              borderRadius="lg"
              p={8}
            >
              <VStack align="center" gap={4}>
                <Heading size="xl" color={textColor} textAlign="center">
                  No Live Polls Available
                </Heading>
                <Text color={textColor} textAlign="center">
                  There are currently no live polls available for this course.
                </Text>
              </VStack>
            </Box>
          </Box>
        ) : (
          <StudentPollsTable polls={polls} onPollClick={handlePollClick} />
        )}
      </VStack>
    </Box>
  );
}
