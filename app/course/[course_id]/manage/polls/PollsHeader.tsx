"use client";

import { Heading, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";

type PollsHeaderProps = {
  courseId: string;
};

export default function PollsHeader({ courseId }: PollsHeaderProps) {
  return (
    <HStack justify="space-between" mb={8}>
      <Heading size="2xl" color="fg.default">
        Manage Polls
      </Heading>
      <Button size="sm" asChild variant="solid" bg="green.500" color="white" _hover={{ bg: "green.600" }}>
        <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create Poll</NextLink>
      </Button>
    </HStack>
  );
}
