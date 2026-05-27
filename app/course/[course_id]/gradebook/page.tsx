"use client";
import { PageContainer } from "@/components/ui/page-container";
import { Heading, Text } from "@chakra-ui/react";
import WhatIf from "./whatIf";

export default function GradebookPage() {
  /*
  To use the &quot;What If&quot; grade
        simulator, click on a score for an assignment, and edit the value. Calculated fields will automatically
        re-calculate, and you can not edit those fields directly.
  */
  return (
    <PageContainer>
      <Heading as="h1" size="lg">
        Gradebook
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        Grades that have been released by your instructor are shown below.
      </Text>
      <WhatIf />
    </PageContainer>
  );
}
