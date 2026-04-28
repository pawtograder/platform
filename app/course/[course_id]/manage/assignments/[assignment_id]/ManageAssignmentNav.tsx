"use client";

import { useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { hasRubricUnsavedChangesFlag, RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE } from "@/lib/rubricUnsavedChanges";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import React, { useCallback } from "react";
import {
  FaCalendar,
  FaChartBar,
  FaCode,
  FaEdit,
  FaHome,
  FaPen,
  FaPlay,
  FaPooStorm,
  FaSearch,
  FaShieldAlt,
  FaUsers
} from "react-icons/fa";
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
  },
  {
    label: "Security Audit",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/security`,
    icon: FaShieldAlt,
    instructorsOnly: true
  },
  {
    label: "Test Insights",
    href: `/course/${courseId}/manage/assignments/${assignmentId}/test-insights`,
    icon: FaChartBar,
    instructorsOnly: "graderOrInstructor"
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
  const router = useRouter();

  const filteredLinkItems = React.useMemo(
    () =>
      LinkItems(parseInt(course_id as string), parseInt(assignment_id as string)).filter((item) => {
        if (!item.instructorsOnly) return true;
        if (item.instructorsOnly === "graderOrInstructor") return isGraderOrInstructor;
        return isInstructor;
      }),
    [course_id, assignment_id, isGraderOrInstructor, isInstructor]
  );
  const selectOptions = React.useMemo(
    () => filteredLinkItems.map((item) => ({ label: item.label, value: item.href })),
    [filteredLinkItems]
  );
  const selectedOption = React.useMemo(() => {
    // Longest-prefix match so nested sub-routes reflect the parent nav entry.
    const match = selectOptions
      .filter((o) => pathname === o.value || pathname.startsWith(o.value + "/"))
      .reduce<(typeof selectOptions)[number] | null>((a, b) => (a && a.value.length >= b.value.length ? a : b), null);
    return match ?? null;
  }, [selectOptions, pathname]);
  const confirmRubricNavigation = useCallback(
    (nextHref: string) => {
      if (!pathname.includes("/rubric")) return true;
      if (pathname === nextHref) return true;
      if (!hasRubricUnsavedChangesFlag(String(assignment_id))) return true;
      return window.confirm(RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE);
    },
    [assignment_id, pathname]
  );

  return (
    <>
      <Flex pt={4} display={{ base: "none", lg: "flex" }}>
        <Box as="nav" aria-label="Assignment management" w="xs" pr={2} flex={0}>
          <VStack align="flex-start">
            {filteredLinkItems.map((item, _idx, arr) => {
              // Exact match wins; otherwise longest-prefix so nested sub-routes
              // (e.g. .../rubric/criteria/123) still highlight their parent entry.
              const longestPrefixHref = arr
                .map((i) => i.href)
                .filter((h) => pathname === h || pathname.startsWith(h + "/"))
                .reduce((a, b) => (b.length > a.length ? b : a), "");
              const isActive = pathname === item.href || item.href === longestPrefixHref;
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
        <Box as="nav" aria-label="Assignment management" width="100%" marginTop="5">
          <Heading size="md" id="manage-assignment-mobile-nav-heading">
            Select assignment page
          </Heading>
          <Select
            aria-labelledby="manage-assignment-mobile-nav-heading"
            onChange={(e) => {
              if (e) {
                if (!confirmRubricNavigation(e.value)) return;
                router.push(e.value);
              }
            }}
            value={selectedOption}
            options={selectOptions}
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
