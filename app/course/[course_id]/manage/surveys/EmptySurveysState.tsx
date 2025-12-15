"use client";

import { Container, Heading, Box, Text, VStack, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useIsInstructor } from "@/hooks/useClassProfiles";

type EmptySurveysStateProps = {
  courseId: string;
};

export default function EmptySurveysState({ courseId }: EmptySurveysStateProps) {
  const isInstructor = useIsInstructor();

  return (
    <Container py={8} maxW="1200px" my={2}>
      <HStack justify="space-between" mb={8}>
        <Heading size="2xl" color="fg.default">
          Manage Surveys
        </Heading>
        {isInstructor && (
          <Button size="sm" asChild variant="solid" bg="green.500" color="white" _hover={{ bg: "green.600" }}>
            <NextLink href={`/course/${courseId}/manage/surveys/new`}>+ Create New Survey</NextLink>
          </Button>
        )}
      </HStack>

      <VStack
        align="center"
        justify="center"
        w="100%"
        h="33vh"
        gap={6}
        bg="bg.subtle"
        border="1px solid"
        borderColor="border.default"
        borderRadius="lg"
        p={12}
        mx="auto"
      >
        <Box textAlign="center">
          <Heading size="lg" mb={3} color="fg.muted" fontWeight="bold">
            No surveys yet
          </Heading>
          <Text fontSize="md" color="fg.muted" mb={8}>
            {isInstructor
              ? "Create your first survey to gather feedback from students."
              : "No surveys have been created yet."}
          </Text>
          {isInstructor && (
            <VStack p={2}>
              <Button size="xs" asChild variant="solid" bg="green.500" color="white" _hover={{ bg: "green.600" }}>
                <NextLink href={`/course/${courseId}/manage/surveys/new`}>+ Create a New Survey</NextLink>
              </Button>
            </VStack>
          )}
        </Box>
      </VStack>
    </Container>
  );
}
