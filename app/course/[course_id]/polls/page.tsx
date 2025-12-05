"use client";

import { Box, Heading, Text, VStack, HStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useActiveLivePolls } from "@/hooks/useCourseController";
import StudentPollsTable from "./StudentPollsTable";

export default function StudentPollsPage() {
  const { course_id } = useParams();
  const { polls, isLoading } = useActiveLivePolls();

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
                <Heading size="xl" color="fg" textAlign="left">
                  Live Polls
                </Heading>
                <Text color="fg" fontSize="md" opacity={0.8}>
                  Participate in live polls for this course.
                </Text>
              </VStack>
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
              bg="bg.muted"
              border="1px solid"
              borderColor="border"
              borderRadius="lg"
              p={8}
            >
              <VStack align="center" gap={4}>
                <Heading size="xl" color="fg" textAlign="center">
                  No Live Polls Available
                </Heading>
                <Text color="fg" textAlign="center">
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
