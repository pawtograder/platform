"use client";
import { useSelfReviewSettings } from "@/hooks/useAssignment";
import { Text } from "@chakra-ui/react";

export default function SelfReviewDueDateInformation() {
  const settings = useSelfReviewSettings();
  return <Text>Self review offset is {settings.deadline_offset}, eventually we will show the due date here</Text>;
}
