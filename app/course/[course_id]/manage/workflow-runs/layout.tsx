"use client";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import React, { useState } from "react";
import { FiBarChart, FiZap, FiAlertTriangle } from "react-icons/fi";

const LinkItems = (courseId: number) => [
  {
    label: "Overview",
    href: `/course/${courseId}/manage/workflow-runs`,
    icon: FiBarChart
  },
  {
    label: "Workflow Runs",
    href: `/course/${courseId}/manage/workflow-runs/runs`,
    icon: FiZap
  },
  {
    label: "Grading Errors",
    href: `/course/${courseId}/manage/workflow-runs/errors`,
    icon: FiAlertTriangle
  }
];

/**
 * Provides a responsive layout for workflow management pages, including navigation and content display.
 *
 * Renders workflow-specific navigation links and content for both desktop and mobile views.
 * Displays navigation for Overview, Workflow Runs, and Grading Errors sections.
 *
 * @param children - The content to display within the workflow runs layout
 */
export default function WorkflowRunsLayout({ children }: { children: React.ReactNode }) {
  const { course_id } = useParams();
  const pathname = usePathname();
  const [selectedPage, setSelectedPage] = useState<string>("");
  const router = useRouter();

  return (
    <>
      <Flex pt={4} display={{ base: "none", lg: "flex" }}>
        <Box w="xs" pr={2} flex={0}>
          <VStack align="flex-start">
            {LinkItems(Number.parseInt(course_id as string)).map((item) => (
              <Button
                key={item.label}
                variant={pathname.endsWith(item.href) ? "solid" : "ghost"}
                w="100%"
                size="xs"
                pt="0"
                fontSize="sm"
                justifyContent="flex-start"
                asChild
              >
                <NextLink href={item.href} prefetch={true}>
                  <HStack textAlign="left" w="100%" justify="flex-start">
                    {React.createElement(item.icon)}
                    {item.label}
                  </HStack>
                </NextLink>
              </Button>
            ))}
          </VStack>
        </Box>
        <Box
          borderColor="border.muted"
          borderWidth="2px"
          borderRadius="md"
          p={4}
          flexGrow={1}
          minWidth="0"
          data-visual-test-no-radius
        >
          <Heading size="lg">Workflow Management</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
      <Flex display={{ base: "flex", lg: "none" }} flexDir={"column"}>
        <Box width="100%" marginTop="5">
          <Heading size="md">Select workflow page</Heading>
          <Select
            onChange={(e) => {
              if (e) {
                setSelectedPage(e.value);
                router.replace(e.value);
              }
            }}
            value={LinkItems(parseInt(course_id as string))
              .map((item) => ({ label: item.label, value: item.href }))
              .find((option) => option.value === selectedPage)}
            options={LinkItems(parseInt(course_id as string)).map((item) => ({
              label: item.label,
              value: item.href
            }))}
          />
        </Box>
        <Box mt={4} borderColor="border.muted" borderWidth="2px" borderRadius="md" p={2} data-visual-test-no-radius>
          <Heading size="lg">Workflow Management</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
    </>
  );
}
