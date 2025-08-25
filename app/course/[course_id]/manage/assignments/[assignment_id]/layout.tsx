"use client";
import { AssignmentProvider, useAssignmentController } from "@/hooks/useAssignment";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { useOne } from "@refinedev/core";
import { Select } from "chakra-react-select";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { FaCalendar, FaCode, FaEdit, FaHome, FaPen, FaPlay, FaPooStorm, FaSearch, FaUsers } from "react-icons/fa";
import { CreateGitHubRepos } from "./CreateGitHubRepos";
import DeleteAssignmentButton from "./deleteAssignmentButton";

const LinkItems = (courseId: number, assignmentId: number) => [
  { label: "Assignment Home", href: `/course/${courseId}/manage/assignments/${assignmentId}`, icon: FaHome },
  { label: "Edit Assignment", href: `/course/${courseId}/manage/assignments/${assignmentId}/edit`, icon: FaEdit },
  {
    label: "Configure Autograder",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/autograder`,
    icon: FaCode
  },
  { label: "Configure Rubric", href: `/course/${courseId}/manage/assignments/${assignmentId}/rubric`, icon: FaPen },
  {
    label: "Manage Due Date Exceptions",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/due-date-exceptions`,
    icon: FaCalendar
  },
  {
    label: "Grading Assignments",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/reviews`,
    icon: FaSearch
  },
  { label: "Manage Groups", href: `/course/${courseId}/manage/assignments/${assignmentId}/groups`, icon: FaUsers },
  {
    label: "Manage Regrade Requests",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/regrade-requests`,
    icon: FaPooStorm
  },
  { label: "Test Assignment", href: `/course/${courseId}/manage/assignments/${assignmentId}/test`, icon: FaPlay },
  {
    label: "Rerun Autograder",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/rerun-autograder`,
    icon: FaPooStorm
  }
];

function AssignmentWindowTitle() {
  const assignment = useAssignmentController();
  useEffect(() => {
    if (assignment?.assignment) {
      document.title = `${assignment.assignment.title} - Pawtograder`;
    }
  }, [assignment?.assignment]);
  return null;
}
/**
 * Provides a responsive layout for assignment management pages, including navigation and content display.
 *
 * Renders assignment-specific navigation links and content for both desktop and mobile views, fetching assignment data and supplying context via an AssignmentProvider. Displays the assignment title and renders nested page content.
 *
 * @param children - The content to display within the assignment layout
 */
export default function AssignmentLayout({ children }: { children: React.ReactNode }) {
  const { course_id, assignment_id } = useParams();
  const isInstructor = useIsInstructor();
  const { data: assignment } = useOne<Assignment>({
    resource: "assignments",
    id: Number.parseInt(assignment_id as string)
  });
  const pathname = usePathname();
  const [selectedPage, setSelectedPage] = useState<string>("");
  const router = useRouter();

  return (
    <AssignmentProvider assignment_id={Number(assignment_id)}>
      <AssignmentWindowTitle />
      <Flex pt={4} display={{ base: "none", lg: "flex" }}>
        <Box w="xs" pr={2} flex={0}>
          <VStack align="flex-start">
            {LinkItems(Number.parseInt(course_id as string), Number.parseInt(assignment_id as string)).map((item) => (
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
            <CreateGitHubRepos
              courseId={Number.parseInt(course_id as string)}
              assignmentId={Number.parseInt(assignment_id as string)}
              releaseDate={assignment?.data?.release_date}
            />
            {isInstructor && (
              <DeleteAssignmentButton
                assignmentId={Number.parseInt(assignment_id as string)}
                courseId={Number.parseInt(course_id as string)}
              />
            )}
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
          <Heading size="lg">Assignment: {assignment ? assignment.data?.title : "Loading..."}</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
      <Flex display={{ base: "flex", lg: "none" }} flexDir={"column"}>
        <Box width="100%" marginTop="5">
          <Heading size="md">Select assignment page</Heading>
          <Select
            onChange={(e) => {
              if (e) {
                setSelectedPage(e.label);
                router.replace(e.value);
              }
            }}
            value={LinkItems(parseInt(course_id as string), parseInt(assignment_id as string))
              .map((item) => ({ label: item.label, value: item.href }))
              .find((option) => option.value === selectedPage)}
            options={LinkItems(parseInt(course_id as string), parseInt(assignment_id as string)).map((item) => ({
              label: item.label,
              value: item.href
            }))}
          />
        </Box>
        <Box mt={4} borderColor="border.muted" borderWidth="2px" borderRadius="md" p={2} data-visual-test-no-radius>
          <Heading size="lg">Assignment: {assignment ? assignment.data?.title : "Loading..."}</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
    </AssignmentProvider>
  );
}
