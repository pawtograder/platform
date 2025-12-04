"use client";

import { Container, Heading, Box, Text, VStack, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useColorModeValue } from "@/components/ui/color-mode";

type EmptyPollsStateProps = {
  courseId: string;
};

export default function EmptyPollsState({ courseId }: EmptyPollsStateProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headingColor = useColorModeValue("#4B5563", "#A0AEC0");
  const descriptionColor = useColorModeValue("#6B7280", "#718096");

  return (
    <Container py={8} maxW="1200px" my={2}>
      <HStack justify="space-between" mb={8}>
        <Heading size="2xl" color={textColor}>
          Manage Polls
        </Heading>
        <Button size="sm" asChild variant="solid" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }}>
          <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create Poll</NextLink>
        </Button>
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
            No polls yet
          </Heading>
          <Text fontSize="md" color={descriptionColor} mb={8}>
            Create your first poll to gather quick feedback from students.
          </Text>
          <VStack p={2}>
            <Button size="xs" asChild variant="solid" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }}>
              <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create a New Poll</NextLink>
            </Button>
          </VStack>
        </Box>
      </VStack>
    </Container>
  );
}