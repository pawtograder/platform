"use client";

import { Heading, Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useIsInstructor } from "@/hooks/useClassProfiles";

type SurveysHeaderProps = {
  courseId: string;
};

export default function SurveysHeader({ courseId }: SurveysHeaderProps) {
  const isInstructor = useIsInstructor();

  return (
    <HStack justify="space-between" mb={8}>
      <Heading size="2xl" color="fg.default">
        Manage Surveys
      </Heading>
      {isInstructor && (
        <HStack gap={2}>
          <Button size="sm" asChild variant="outline">
            <NextLink href={`/course/${courseId}/manage/surveys/series`}>Manage Series</NextLink>
          </Button>
          <Button size="sm" asChild variant="solid" bg="green.500" color="white" _hover={{ bg: "green.600" }}>
            <NextLink href={`/course/${courseId}/manage/surveys/new`}>+ Create New Survey</NextLink>
          </Button>
        </HStack>
      )}
    </HStack>
  );
}
