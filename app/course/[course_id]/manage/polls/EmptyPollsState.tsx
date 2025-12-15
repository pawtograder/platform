"use client";

import { Container, Heading, Box, Text, VStack, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";

type EmptyPollsStateProps = {
  courseId: string;
};

export default function EmptyPollsState({ courseId }: EmptyPollsStateProps) {
  return (
    <Container py={8} maxW="1200px" my={2}>
      <HStack justify="space-between" mb={8}>
        <Heading size="2xl" color="fg.default">
          Manage Polls
        </Heading>
        <Button size="sm" asChild variant="solid" bg="green.500" color="white" _hover={{ bg: "green.600" }}>
          <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create Poll</NextLink>
        </Button>
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
            No polls yet
          </Heading>
          <Text fontSize="md" color="fg.muted" mb={8}>
            Create your first poll to gather quick feedback from students.
          </Text>
          <VStack p={2}>
            <Button size="xs" asChild variant="solid" bg="green.500" color="white" _hover={{ bg: "green.600" }}>
              <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create a New Poll</NextLink>
            </Button>
          </VStack>
        </Box>
      </VStack>
    </Container>
  );
}
