"use client";

import { Heading, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useCapability } from "@/hooks/useClassProfiles";

type PollsHeaderProps = {
  courseId: string;
};

export default function PollsHeader({ courseId }: PollsHeaderProps) {
  const canRunPolls = useCapability("run_polls");

  return (
    <HStack justify="space-between" mb={8}>
      <Heading size="2xl" color="fg.default">
        Manage Polls
      </Heading>
      {canRunPolls && (
        <Button size="sm" asChild variant="solid" colorPalette="green">
          <NextLink href={`/course/${courseId}/manage/polls/new`}>+ Create Poll</NextLink>
        </Button>
      )}
    </HStack>
  );
}
