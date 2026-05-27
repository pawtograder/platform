"use client";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import React, { useMemo } from "react";
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
export default function WorkflowRunsLayoutClient({ children }: { children: React.ReactNode }) {
  const { course_id } = useParams();
  const pathname = usePathname();
  const router = useRouter();

  const courseIdNum = Number.parseInt(course_id as string, 10);
  const linkItems = useMemo(() => LinkItems(courseIdNum), [courseIdNum]);
  const selectOptions = useMemo(() => linkItems.map((item) => ({ label: item.label, value: item.href })), [linkItems]);

  /** Single active tab: longest `href` that is an exact path or proper prefix (`href/`…). */
  const bestMatch = useMemo(() => {
    const candidates = linkItems.filter((item) => pathname === item.href || pathname.startsWith(item.href + "/"));
    if (candidates.length === 0) return null;
    return candidates.reduce((longest, item) => (item.href.length > longest.href.length ? item : longest));
  }, [linkItems, pathname]);

  const selectedOption = useMemo(
    () => (bestMatch ? { label: bestMatch.label, value: bestMatch.href } : null),
    [bestMatch]
  );

  return (
    <>
      <Flex pt={4} display={{ base: "none", lg: "flex" }}>
        <Box as="nav" aria-label="Workflow runs" w="xs" pr={2} flex={0}>
          <VStack align="flex-start">
            {linkItems.map((item) => {
              const isActive = bestMatch === item;
              return (
                <Button
                  key={item.label}
                  variant={isActive ? "solid" : "ghost"}
                  w="100%"
                  size="xs"
                  pt="0"
                  fontSize="sm"
                  justifyContent="flex-start"
                  asChild
                >
                  <NextLink href={item.href} aria-current={isActive ? "page" : undefined}>
                    <HStack textAlign="left" w="100%" justify="flex-start">
                      {React.createElement(item.icon)}
                      {item.label}
                    </HStack>
                  </NextLink>
                </Button>
              );
            })}
          </VStack>
        </Box>
        <Box borderColor="border.muted" borderWidth="2px" borderRadius="md" p={4} flexGrow={1} minWidth="0">
          <Heading size="lg">Workflow Management</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
      <Flex display={{ base: "flex", lg: "none" }} flexDir={"column"}>
        <Box as="nav" aria-label="Workflow runs" width="100%" marginTop="5">
          <Heading size="md" id="workflow-mobile-nav-heading">
            Select workflow page
          </Heading>
          <Select
            aria-labelledby="workflow-mobile-nav-heading"
            onChange={(e) => {
              if (e) router.push(e.value);
            }}
            value={selectedOption}
            options={selectOptions}
          />
        </Box>
        <Box mt={4} borderColor="border.muted" borderWidth="2px" borderRadius="md" p={2}>
          <Heading size="lg">Workflow Management</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
    </>
  );
}
