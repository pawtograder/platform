"use client";

import { Heading, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useColorModeValue } from "@/components/ui/color-mode";

type PollsHeaderProps = {
  courseId: string;
};

export default function PollsHeader({ courseId }: PollsHeaderProps) {
  const textColor = useColorModeValue("#000000", "#FFFFFF");

  return (
    <HStack justify="space-between" mb={8}>
      <Heading size="2xl" color={textColor}>
        Manage Polls
      </Heading>
      <Button size="sm" asChild variant="solid" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }}>
        <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create Poll</NextLink>
      </Button>
    </HStack>
  );
}