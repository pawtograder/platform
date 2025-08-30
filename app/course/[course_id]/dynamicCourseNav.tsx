"use client";

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
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Course, CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, HStack, Menu, Portal, Skeleton, Text, VStack, Dialog } from "@chakra-ui/react";
import Image from "next/image";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import React, { Fragment, useEffect, useRef } from "react";
import { FaRobot, FaScroll } from "react-icons/fa";
import {
  FiAlertCircle,
  FiBookOpen,
  FiClipboard,
  FiClock,
  FiCompass,
  FiMenu,
  FiMessageSquare,
  FiSettings,
  FiStar,
  FiUsers
} from "react-icons/fi";
import { MdOutlineMail, MdOutlineScience } from "react-icons/md";
import { TbCards } from "react-icons/tb";
import UserMenu from "../UserMenu";
import { useTimeZonePreference } from "@/hooks/useTimeZonePreference";
import useModalManager from "@/hooks/useModalManager";

const LinkItems = (courseID: number) => [
  { name: "Assignments", icon: FiCompass, student_only: true, target: `/course/${courseID}/assignments` },
  {
    name: "Manage Assignments",
    icon: FiCompass,
    instructors_or_graders_only: true,
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
    instructors_or_graders_only: true,
    icon: FiClipboard,
    target: `/course/${courseID}/manage/office-hours`
    // feature_flag: "office-hours"
  },
  { name: "Gradebook", icon: FiBookOpen, student_only: true, target: `/course/${courseID}/gradebook` },
  { name: "Gradebook", icon: FiBookOpen, instructor_only: true, target: `/course/${courseID}/manage/gradebook` },
  {
    name: "Course Settings",
    icon: FiSettings,
    instructors_or_graders_only: true,
    target: `/course/${courseID}/manage/course/`,
    submenu: [
      {
        name: "Enrollments",
        icon: FiUsers,
        instructors_only: true,
        target: `/course/${courseID}/manage/course/enrollments`
      },
      {
        name: "Lab Sections",
        instructors_only: true,
        icon: MdOutlineScience,
        target: `/course/${courseID}/manage/course/lab-sections`
      },
      { name: "Flashcard Decks", icon: TbCards, target: `/course/${courseID}/manage/course/flashcard-decks` },
      { name: "Grading Conflicts", icon: FiAlertCircle, target: `/course/${courseID}/manage/course/grading-conflicts` },
      {
        name: "Due Date Exceptions",
        instructors_only: true,
        icon: FiClock,
        target: `/course/${courseID}/manage/course/due-date-exceptions`
      },
      { name: "Audit Log", instructors_only: true, icon: FaScroll, target: `/course/${courseID}/manage/course/audit` },
      {
        name: "Emailer",
        instructors_only: true,
        icon: MdOutlineMail,
        target: `/course/${courseID}/manage/course/emails`
      },
      {
        name: "Workflow Runs",
        instructors_only: true,
        icon: FaRobot,
        target: `/course/${courseID}/manage/workflow-runs`
      }
    ]
  }
];

function CoursePicker({ currentCourse }: { currentCourse: Course }) {
  const { allOfMyRoles } = useClassProfiles();
  if (allOfMyRoles.length === 1) {
    return <></>;
  }
  const uniqueCourses: Course[] = [];
  allOfMyRoles.forEach((r) => {
    if (r.classes && !uniqueCourses.some((uc) => uc.id === r.classes!.id)) {
      uniqueCourses.push(r.classes);
    }
  });
  const courseSorter = (a: Course, b: Course) => {
    if (a.term && b.term) {
      const ret = b.term - a.term;
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
                  <SemesterText semester={course.term} />
                </Text>
              </Fragment>
            ))}
        </DrawerBody>
        <DrawerCloseTrigger />
      </DrawerContent>
    </DrawerRoot>
  );
}

function TimeZonePreferenceModal({ courseId, courseTz }: { courseId: number; courseTz: string }) {
  const { isOpen, openModal, closeModal } = useModalManager();
  const { shouldPrompt, browserTimeZone, setPreferenceChoice } = useTimeZonePreference(courseId, courseTz);

  useEffect(() => {
    if (shouldPrompt) {
      openModal();
    }
  }, [shouldPrompt, openModal]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => (e.open ? openModal() : closeModal())}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Select your time zone preference</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack alignItems="flex-start">
                <Text>
                  Your browser time zone (<b>{browserTimeZone}</b>) differs from this course&apos;s time zone (
                  <b>{courseTz}</b>).
                </Text>
                <Text>Choose how you want due dates to be displayed:</Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack width="100%" justifyContent="space-between">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreferenceChoice("course");
                    closeModal();
                  }}
                >
                  Use course time zone ({courseTz})
                </Button>
                <Button
                  colorPalette="green"
                  onClick={() => {
                    setPreferenceChoice("browser");
                    closeModal();
                  }}
                >
                  Use my browser time zone ({browserTimeZone})
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Renders a one-line message indicating the effective time zone used for displaying times.
 * Internally uses `useTimeZonePreference` to resolve the display zone.
 */
function TimeZoneDisplay({
  courseId,
  courseTz,
  fontSize,
  prefix
}: {
  courseId: number;
  courseTz: string;
  fontSize: "xs" | "sm";
  prefix: string;
}) {
  const { displayTimeZone } = useTimeZonePreference(courseId, courseTz);
  return (
    <Text fontSize={fontSize} color="fg.muted">
      {prefix} {displayTimeZone}
    </Text>
  );
}

export default function DynamicCourseNav() {
  const pathname = usePathname();
  const courseNavRef = useRef<HTMLDivElement>(null);
  const { role: enrollment } = useClassProfiles();
  const { colorMode } = useColorMode();

  const isInstructor = enrollment.role === "instructor";
  const isInstructorOrGrader = enrollment.role === "instructor" || enrollment.role === "grader";

  useEffect(() => {
    if (courseNavRef.current) {
      const height = courseNavRef.current.offsetHeight;
      document.documentElement.style.setProperty("--nav-height", `${height + 10}px`);
    }
  });

  if (!enrollment) {
    return <Skeleton height="40" width="100%" />;
  }

  const course = enrollment.classes as CourseWithFeatures;
  const filteredLinks = LinkItems(enrollment.class_id)
    .filter(
      (link) =>
        (!link.instructors_or_graders_only || isInstructorOrGrader) &&
        (!link.student_only || !isInstructorOrGrader) &&
        (!link.instructor_only || isInstructor)
    )
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
              <CoursePicker currentCourse={enrollment.classes} />
              {colorMode === "dark" ? (
                <Image src="/Logo-Dark.png" width={30} height={30} alt="Logo" />
              ) : (
                <Image src="/Logo-Light.png" width={30} height={30} alt="Logo" />
              )}
              <Text fontSize="md" fontWeight="medium">
                <Link variant="plain" href={`/course/${enrollment.class_id}`}>
                  {enrollment.classes.course_title ?? enrollment.classes.name}
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
                              {link.submenu
                                .filter((submenu) => !submenu.instructors_only || isInstructor)
                                .map((submenu) => (
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

          <TimeZoneDisplay
            courseId={enrollment.class_id}
            courseTz={course.time_zone || "America/New_York"}
            fontSize="xs"
            prefix="Displaying times in"
          />
        </VStack>
      </Box>

      {/* Desktop Layout - unchanged */}
      <Box display={{ base: "none", md: "block" }}>
        <Flex width="100%" pt="2" alignItems="center" justifyContent="space-between">
          <VStack gap="0" align="start">
            <HStack>
              <CoursePicker currentCourse={enrollment.classes} />
              {colorMode === "dark" ? (
                <Image src="/Logo-Dark.png" width={30} height={30} alt="Logo" />
              ) : (
                <Image src="/Logo-Light.png" width={30} height={30} alt="Logo" />
              )}
              <Text fontSize="xl" fontWeight="medium">
                <Link variant="plain" href={`/course/${enrollment.class_id}`}>
                  {enrollment.classes.course_title ?? enrollment.classes.name}
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
                              {link.submenu
                                .filter((submenu) => !submenu.instructors_only || isInstructor)
                                .map((submenu) => (
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
          <TimeZoneDisplay
            courseId={enrollment.class_id}
            courseTz={course.time_zone || "America/New_York"}
            fontSize="sm"
            prefix="Times shown in"
          />
          <UserMenu />
        </Flex>
      </Box>
      <TimeZonePreferenceModal courseId={enrollment.class_id} courseTz={course.time_zone || "America/New_York"} />
    </Box>
  );
}
