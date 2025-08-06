"use client";

import { Alert } from "@/components/ui/alert";
import { useColorMode } from "@/components/ui/color-mode";
import {
  DrawerBackdrop,
  DrawerBody,
  DrawerCloseTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerRoot,
  DrawerTitle,
  DrawerTrigger
} from "@/components/ui/drawer";
import Link from "@/components/ui/link";
import SemesterText from "@/components/ui/semesterText";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import type { Course, CourseWithFeatures, UserRoleWithCourse } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, HStack, Menu, Portal, Skeleton, Text, VStack } from "@chakra-ui/react";
import Image from "next/image";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import React, { Fragment, useEffect, useRef, useState } from "react";
import { FaRobot, FaScroll } from "react-icons/fa";
import {
  FiAlertCircle,
  FiBookOpen,
  FiClipboard,
  FiCompass,
  FiMenu,
  FiMessageSquare,
  FiSettings,
  FiStar,
  FiUsers
} from "react-icons/fi";
import { TbCards } from "react-icons/tb";
import UserMenu from "../UserMenu";
import { MdOutlineMail, MdOutlineScience } from "react-icons/md";

const LinkItems = (courseID: number) => [
  { name: "Assignments", icon: FiCompass, student_only: true, target: `/course/${courseID}/assignments` },
  {
    name: "Manage Assignments",
    icon: FiCompass,
    instructor_only: true,
    target: `/course/${courseID}/manage/assignments`
  },
  { name: "Discussion", icon: FiStar, target: `/course/${courseID}/discussion` },
  { name: "Flashcards", icon: TbCards, student_only: true, target: `/course/${courseID}/flashcards` },
  {
    name: "Office Hours",
    student_only: true,
    icon: FiMessageSquare,
    target: `/course/${courseID}/office-hours`
    // feature_flag: "office-hours"
  },
  {
    name: "Office Hours",
    instructor_only: true,
    icon: FiClipboard,
    target: `/course/${courseID}/manage/office-hours`
    // feature_flag: "office-hours"
  },
  { name: "Gradebook", icon: FiBookOpen, student_only: true, target: `/course/${courseID}/gradebook` },
  { name: "Gradebook", icon: FiBookOpen, instructor_only: true, target: `/course/${courseID}/manage/gradebook` },
  {
    name: "Course Settings",
    icon: FiSettings,
    instructor_only: true,
    target: `/course/${courseID}/manage/course/`,
    submenu: [
      { name: "Enrollments", icon: FiUsers, target: `/course/${courseID}/manage/course/enrollments` },
      { name: "Lab Sections", icon: MdOutlineScience, target: `/course/${courseID}/manage/course/lab-sections` },
      { name: "Flashcard Decks", icon: TbCards, target: `/course/${courseID}/manage/course/flashcard-decks` },
      { name: "Grading Conflicts", icon: FiAlertCircle, target: `/course/${courseID}/manage/course/grading-conflicts` },
      { name: "Audit Log", icon: FaScroll, target: `/course/${courseID}/manage/course/audit` },
      { name: "Emailer", icon: MdOutlineMail, target: `/course/${courseID}/manage/course/emails` },
      { name: "Workflow Runs", icon: FaRobot, target: `/course/${courseID}/manage/workflow-runs` }
    ]
  }
];

function CoursePicker({ courses, currentCourse }: { courses: UserRoleWithCourse[]; currentCourse: Course }) {
  if (courses.length === 1) {
    return <></>;
  }
  const uniqueCourses: Course[] = [];
  courses.forEach((c) => {
    if (c.classes && !uniqueCourses.some((uc) => uc.id === c.classes!.id)) {
      uniqueCourses.push(c.classes);
    }
  });
  const courseSorter = (a: Course, b: Course) => {
    if (a.semester && b.semester) {
      const ret = b.semester - a.semester;
      if (ret !== 0) {
        return ret;
      }
    }
    return a.name!.localeCompare(b.name!);
  };
  return (
    <DrawerRoot size="xs" placement="start">
      <DrawerBackdrop />
      <DrawerTrigger asChild>
        <Button variant="ghost" colorPalette="gray" size="sm" aria-label="Open course picker" p={0}>
          <FiMenu />
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Your Courses</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          {Array.from(uniqueCourses)
            .sort(courseSorter)
            .map((course) => (
              <Fragment key={course.id}>
                <Link variant={course.id === currentCourse.id ? "underline" : "plain"} href={`/course/${course.id}`}>
                  {course.name}
                </Link>
                <Text fontSize="sm" color="gray.500">
                  <SemesterText semester={course.semester} />
                </Text>
              </Fragment>
            ))}
        </DrawerBody>
        <DrawerCloseTrigger />
      </DrawerContent>
    </DrawerRoot>
  );
}

function TimeZoneWarning({ courseTz }: { courseTz: string }) {
  const [dismissed, setDismissed] = useState(false);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (courseTz === browserTz || dismissed) {
    return <></>;
  }
  return (
    <Alert
      status="warning"
      w={{ base: "100%", md: "fit-content" }}
      size="sm"
      closable
      onClose={() => setDismissed(true)}
    >
      Warning: This course is in {courseTz} but your computer appears to be in {browserTz}
    </Alert>
  );
}

export default function DynamicCourseNav() {
  const pathname = usePathname();
  const courseNavRef = useRef<HTMLDivElement>(null);
  const { role: enrollment } = useClassProfiles();
  const { roles: courses } = useAuthState();
  const { colorMode } = useColorMode();
  const isInstructor = enrollment.role === "instructor" || enrollment.role === "grader";

  useEffect(() => {
    if (courseNavRef.current) {
      const height = courseNavRef.current.offsetHeight;
      document.documentElement.style.setProperty("--nav-height", `${height + 10}px`);
    }
  });

  if (!enrollment || !courses) {
    return <Skeleton height="40" width="100%" />;
  }

  const course = enrollment.classes as CourseWithFeatures;
  const filteredLinks = LinkItems(enrollment.class_id)
    .filter((link) => (!link.instructor_only || isInstructor) && (!link.student_only || !isInstructor))
    .filter((link) => !("feature_flag" in link) || course.features?.find((f) => f.name === link.feature_flag)?.enabled);

  return (
    <Box
      px={{ base: 2, md: 4 }}
      py={{ base: 2, md: 2 }}
      ref={courseNavRef}
      id="course-nav"
      bg="bg.subtle"
      borderBottomWidth="1px"
      borderBottomColor="border.emphasized"
    >
      {/* Mobile Layout */}
      <Box display={{ base: "block", md: "none" }}>
        <VStack gap={2} align="stretch">
          {/* Top row: Course picker, logo, course name, user menu */}
          <HStack justifyContent="space-between" alignItems="center">
            <HStack>
              <CoursePicker courses={courses} currentCourse={enrollment.classes} />
              {colorMode === "dark" ? (
                <Image src="/Logo-Dark.png" width={30} height={30} alt="Logo" />
              ) : (
                <Image src="/Logo-Light.png" width={30} height={30} alt="Logo" />
              )}
              <Text fontSize="md" fontWeight="medium">
                <Link variant="plain" href={`/course/${enrollment.class_id}`}>
                  {enrollment.classes.name}
                </Link>
              </Text>
            </HStack>
            <UserMenu />
          </HStack>

          {/* Navigation links - horizontal scroll on mobile */}
          <Box overflowX="auto" overflowY="hidden" pb={1}>
            <HStack gap={1} minWidth="max-content">
              {filteredLinks.map((link) => {
                if (link.submenu) {
                  return (
                    <Box
                      key={link.name}
                      borderBottom={pathname.startsWith(link.target || "#") ? "2px solid" : "none"}
                      borderColor="orange.600"
                      flexShrink={0}
                    >
                      <Menu.Root>
                        <Menu.Trigger asChild>
                          <Button
                            colorPalette="gray"
                            size="xs"
                            fontSize="xs"
                            px={2}
                            py={1}
                            variant="ghost"
                            whiteSpace="nowrap"
                          >
                            <HStack gap={1}>
                              {React.createElement(link.icon, { size: 14 })}
                              <Text>{link.name}</Text>
                            </HStack>
                          </Button>
                        </Menu.Trigger>
                        <Portal>
                          <Menu.Positioner>
                            <Menu.Content>
                              {link.submenu.map((submenu) => (
                                <Menu.Item key={submenu.name} value={submenu.name} asChild>
                                  <NextLink prefetch={true} href={submenu.target || "#"}>
                                    {React.createElement(submenu.icon)}
                                    {submenu.name}
                                  </NextLink>
                                </Menu.Item>
                              ))}
                            </Menu.Content>
                          </Menu.Positioner>
                        </Portal>
                      </Menu.Root>
                    </Box>
                  );
                } else {
                  return (
                    <Box
                      key={link.name}
                      borderBottom={pathname.startsWith(link.target || "#") ? "2px solid" : "none"}
                      borderColor="orange.600"
                      flexShrink={0}
                    >
                      <Button
                        colorPalette="gray"
                        size="xs"
                        fontSize="xs"
                        px={2}
                        py={1}
                        variant="ghost"
                        whiteSpace="nowrap"
                        asChild
                      >
                        <NextLink prefetch={true} href={link.target || "#"}>
                          <HStack gap={1}>
                            {React.createElement(link.icon, { size: 14 })}
                            <Text>{link.name}</Text>
                          </HStack>
                        </NextLink>
                      </Button>
                    </Box>
                  );
                }
              })}
            </HStack>
          </Box>

          {/* Timezone warning */}
          <TimeZoneWarning courseTz={enrollment.classes.time_zone || "America/New_York"} />
        </VStack>
      </Box>

      {/* Desktop Layout - unchanged */}
      <Box display={{ base: "none", md: "block" }}>
        <Flex width="100%" pt="2" alignItems="center" justifyContent="space-between">
          <VStack gap="0" align="start">
            <HStack>
              <CoursePicker courses={courses} currentCourse={enrollment.classes} />
              {colorMode === "dark" ? (
                <Image src="/Logo-Dark.png" width={30} height={30} alt="Logo" />
              ) : (
                <Image src="/Logo-Light.png" width={30} height={30} alt="Logo" />
              )}
              <Text fontSize="xl" fontWeight="medium">
                <Link variant="plain" href={`/course/${enrollment.class_id}`}>
                  {enrollment.classes.name}
                </Link>
              </Text>
            </HStack>
            <HStack width="100%" mt={2}>
              {filteredLinks.map((link) => {
                if (link.submenu) {
                  return (
                    <Box
                      key={link.name}
                      borderBottom={pathname.startsWith(link.target || "#") ? "3px solid" : "none"}
                      borderColor="orange.600"
                    >
                      <Menu.Root>
                        <Menu.Trigger asChild>
                          <Button colorPalette="gray" size="xs" fontSize="sm" pt="0" variant="ghost" asChild>
                            <Flex align="center" role="group">
                              <HStack>
                                {React.createElement(link.icon)}
                                {link.name}
                              </HStack>
                            </Flex>
                          </Button>
                        </Menu.Trigger>
                        <Portal>
                          <Menu.Positioner>
                            <Menu.Content>
                              {link.submenu.map((submenu) => (
                                <Menu.Item key={submenu.name} value={submenu.name} asChild>
                                  <NextLink prefetch={true} href={submenu.target || "#"}>
                                    {React.createElement(submenu.icon)}
                                    {submenu.name}
                                  </NextLink>
                                </Menu.Item>
                              ))}
                            </Menu.Content>
                          </Menu.Positioner>
                        </Portal>
                      </Menu.Root>
                    </Box>
                  );
                } else {
                  return (
                    <Box
                      key={link.name}
                      borderBottom={pathname.startsWith(link.target || "#") ? "3px solid" : "none"}
                      borderColor="orange.600"
                    >
                      <Button colorPalette="gray" size="xs" fontSize="sm" pt="0" variant="ghost" asChild>
                        <NextLink prefetch={true} href={link.target || "#"}>
                          <Flex align="center" role="group">
                            <HStack>
                              {React.createElement(link.icon)}
                              {link.name}
                            </HStack>
                          </Flex>
                        </NextLink>
                      </Button>
                    </Box>
                  );
                }
              })}
            </HStack>
          </VStack>
          <TimeZoneWarning courseTz={enrollment.classes.time_zone || "America/New_York"} />
          <UserMenu />
        </Flex>
      </Box>
    </Box>
  );
}
