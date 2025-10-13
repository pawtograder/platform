"use client";

import { useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import React, { useState } from "react";
import { FaCalendar, FaCode, FaEdit, FaHome, FaPen, FaPlay, FaPooStorm, FaSearch, FaUsers } from "react-icons/fa";
import DeleteAssignmentButton from "./deleteAssignmentButton";

const LinkItems = (courseId: number, assignmentId: number) => [
  { label: "Assignment Home", href: `/course/${courseId}/manage/assignments/${assignmentId}`, icon: FaHome },
  {
    label: "Edit Assignment",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/edit`,
    icon: FaEdit,
    instructorsOnly: true
  },
  {
    label: "Configure Autograder",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/autograder`,
    icon: FaCode,
    instructorsOnly: true
  },
  {
    label: "Configure Rubric",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/rubric`,
    icon: FaPen,
    instructorsOnly: true
  },
  { label: "Test Assignment", href: `/course/${courseId}/manage/assignments/${assignmentId}/test`, icon: FaPlay },
  {
    label: "Repository Status",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/repositories`,
    icon: FaCode,
    instructorsOnly: true
  },
  {
    label: "Rerun Autograder",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/rerun-autograder`,
    icon: FaPooStorm,
    instructorsOnly: true
  },
  {
    label: "Manage Due Date Exceptions",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/due-date-exceptions`,
    icon: FaCalendar
  },
  {
    label: "Grading Assignments",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/reviews`,
    icon: FaSearch,
    instructorsOnly: "graderOrInstructor"
  },
  {
    label: "Manage Groups",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/groups`,
    icon: FaUsers,
    instructorsOnly: "graderOrInstructor"
  },
  {
    label: "Manage Regrade Requests",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/regrade-requests`,
    icon: FaPooStorm
  }
];

/**
 * Client component for assignment management navigation and interactive UI
 */
export function ManageAssignmentNav({
  children,
  assignmentTitle
}: {
  children: React.ReactNode;
  assignmentTitle: string | null | undefined;
}) {
  const { course_id, assignment_id } = useParams();
  const isInstructor = useIsInstructor();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const pathname = usePathname();
  const [selectedPage, setSelectedPage] = useState<string>("");
  const router = useRouter();

  return (
    <>
      <Flex pt={4} display={{ base: "none", lg: "flex" }}>
        <Box w="xs" pr={2} flex={0}>
          <VStack align="flex-start">
            {LinkItems(Number.parseInt(course_id as string), Number.parseInt(assignment_id as string))
              .filter((item) => {
                if (!item.instructorsOnly) return true;
                if (item.instructorsOnly === "graderOrInstructor") return isGraderOrInstructor;
                return isInstructor;
              })
              .map((item) => (
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
                  <NextLink href={item.href}>
                    <HStack textAlign="left" w="100%" justify="flex-start">
                      {React.createElement(item.icon)}
                      {item.label}
                    </HStack>
                  </NextLink>
                </Button>
              ))}
            {isInstructor && (
              <DeleteAssignmentButton
                assignmentId={Number.parseInt(assignment_id as string)}
                courseId={Number.parseInt(course_id as string)}
              />
            )}
          </VStack>
        </Box>
        <Box borderColor="border.muted" borderWidth="2px" borderRadius="md" p={4} flexGrow={1} minWidth="0">
          <Heading size="lg">Assignment: {assignmentTitle || "Loading..."}</Heading>
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
              .filter((item) => {
                if (!item.instructorsOnly) return true;
                if (item.instructorsOnly === "graderOrInstructor") return isGraderOrInstructor;
                return isInstructor;
              })
              .map((item) => ({ label: item.label, value: item.href }))
              .find((option) => option.value === selectedPage)}
            options={LinkItems(parseInt(course_id as string), parseInt(assignment_id as string))
              .filter((item) => {
                if (!item.instructorsOnly) return true;
                if (item.instructorsOnly === "graderOrInstructor") return isGraderOrInstructor;
                return isInstructor;
              })
              .map((item) => ({
                label: item.label,
                value: item.href
              }))}
          />
        </Box>
        <Box mt={4} borderColor="border.muted" borderWidth="2px" borderRadius="md" p={2}>
          <Heading size="lg">Assignment: {assignmentTitle || "Loading..."}</Heading>
          <Box>{children}</Box>
        </Box>
      </Flex>
    </>
  );
}
