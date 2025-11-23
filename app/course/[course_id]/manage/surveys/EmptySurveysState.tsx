"use client";

import { Container, Heading, Box, Text, VStack, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useColorModeValue } from "@/components/ui/color-mode";
import { useIsInstructor } from "@/hooks/useClassProfiles";

type EmptySurveysStateProps = {
  courseId: string;
};

export default function EmptySurveysState({ courseId }: EmptySurveysStateProps) {
  // Color mode values - same as the form
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headingColor = useColorModeValue("#4B5563", "#A0AEC0");
  const descriptionColor = useColorModeValue("#6B7280", "#718096");
  const isInstructor = useIsInstructor();

  return (
    <Container py={8} maxW="1200px" my={2}>
      <HStack justify="space-between" mb={8}>
        <Heading size="2xl" color={textColor}>
          Manage Surveys
        </Heading>
        {isInstructor && (
          <Button size="sm" asChild variant="solid" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }}>
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
        bg={cardBgColor}
        border="1px solid"
        borderColor={borderColor}
        borderRadius="lg"
        p={12}
        mx="auto"
      >
        <Box textAlign="center">
          <Heading size="lg" mb={3} color={headingColor} fontWeight="bold">
            No surveys yet
          </Heading>
          <Text fontSize="md" color={descriptionColor} mb={8}>
            {isInstructor
              ? "Create your first survey to gather feedback from students."
              : "No surveys have been created yet."}
          </Text>
          {isInstructor && (
            <VStack p={2}>
              <Button size="xs" asChild variant="solid" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }}>
                <NextLink href={`/course/${courseId}/manage/surveys/new`}>+ Create a New Survey</NextLink>
              </Button>
            </VStack>
          )}
        </Box>
      </VStack>
    </Container>
  );
}
