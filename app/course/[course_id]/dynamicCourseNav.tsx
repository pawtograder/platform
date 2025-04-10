'use client'

import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Flex, HStack, Skeleton, VStack, Text, Menu, Portal } from "@chakra-ui/react";
import { usePathname, useRouter } from "next/navigation";
import {
    FiBook,
    FiCalendar,
    FiCompass,
    FiHome,
    FiMessageSquare,
    FiSettings,
    FiStar,
    FiTrendingUp,
    FiClipboard,
    FiMenu,
    FiUsers
} from 'react-icons/fi'
import NextLink from "next/link";
import UserMenu from "../UserMenu";
import React, { Fragment, useEffect, useRef } from "react";
import useAuthState from "@/hooks/useAuthState";
import { Course, UserRoleWithCourse } from "@/utils/supabase/DatabaseTypes";
import {
    DrawerActionTrigger,
    DrawerBackdrop,
    DrawerBody,
    DrawerCloseTrigger,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    DrawerRoot,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer"
import Link from "@/components/ui/link";
import SemesterText from "@/components/ui/semesterText";
import { ColorModeButton, useColorMode } from "@/components/ui/color-mode";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { FaScroll } from "react-icons/fa";
const LinkItems = (courseID: number) => ([
    { name: 'Assignments', icon: FiCompass, student_only: true, target: `/course/${courseID}/assignments` },
    { name: 'Manage Assignments', icon: FiCompass, instructor_only: true, target: `/course/${courseID}/manage/assignments` },
    { name: 'Discussion', icon: FiStar, target: `/course/${courseID}/discussion` },
    // { name: 'Flashcards', icon: FiBook, target: `/course/${courseID}/flashcards` },
    { name: 'Get Help Now', student_only: true, icon: FiMessageSquare, target: `/course/${courseID}/help` },
    { name: 'Give Help Now', instructor_only: true, icon: FiClipboard, target: `/course/${courseID}/manage/help` },
    // {name: 'Trending', icon: FiTrendingUp },
    // {name: 'Explore', icon: FiCompass },
    // {name: 'Favourites', icon: FiStar },
    { name: 'Enrollments', icon: FiUsers, instructor_only: true, target: `/course/${courseID}/manage/enrollments` },
    {
        name: 'Course Settings', icon: FiSettings, instructor_only: true,
        target: `/course/${courseID}/manage/course/`,
        submenu: [
            { name: 'Enrollments', icon: FiUsers, target: `/course/${courseID}/manage/course/enrollments` },
            { name: 'Audit Log', icon: FaScroll, target: `/course/${courseID}/manage/course/audit` },
        ]
    },
]);

function CoursePicker({ courses, currentCourse }: { courses: UserRoleWithCourse[], currentCourse: Course }) {
    if (courses.length === 1) {
        return <></>
    }
    const uniqueCourses: Course[] = [];
    courses.forEach(c => {
        if (c.classes && !uniqueCourses.some(uc => uc.id === c.classes!.id)) {
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
    }
    return <DrawerRoot size='xs' placement='start'>
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
                {Array.from(uniqueCourses).sort(courseSorter).map((course) => (
                    <Fragment key={course.id}>
                        <Link variant={course.id === currentCourse.id ? "underline" : "plain"} href={`/course/${course.id}`}>{course.name}</Link>
                        <Text fontSize="sm" color="gray.500"><SemesterText semester={course.semester} /></Text>
                    </Fragment>
                ))}
            </DrawerBody>
            <DrawerCloseTrigger />
        </DrawerContent>
    </DrawerRoot>
}
export default function DynamicCourseNav() {
    const router = useRouter();
    const pathname = usePathname();
    const courseNavRef = useRef<HTMLDivElement>(null);
    const { role: course } = useClassProfiles();
    const { roles: courses } = useAuthState();
    const { colorMode } = useColorMode();
    const isInstructor = course.role === "instructor";
    useEffect(() => {
        if (courseNavRef.current) {
            const height = courseNavRef.current.offsetHeight;
            document.documentElement.style.setProperty('--nav-height', `${height + 10}px`);
        }
    }, [courseNavRef?.current]);
    if (!course || !courses) {
        return <Skeleton height="40" width="100%" />;
    }
    return (
        <Box px={{ base: 4, md: 4 }}
            ref={courseNavRef}
            id="course-nav"
            alignItems="start"
            bg='bg.subtle'
            gap="0"
            borderBottomWidth="1px"
            borderBottomColor='border.emphasized'
        >
            <Flex
                width="100%"
                pt="2"
                alignItems="center"
                justifyContent={{ base: 'space-between' }}
            >
                <VStack gap="0" align="start">
                    <HStack
                    >
                        <CoursePicker courses={courses} currentCourse={course.classes} />
                        {colorMode === 'dark' ? (
                            <img src="/Logo-Dark.png" width="30px" alt="Logo" />
                        ) : (
                            <img src="/Logo-Light.png" width="30px" alt="Logo" />
                        )}
                        <Text fontSize="xl" fontWeight="medium">
                            <Link variant="plain" href={`/course/${course.class_id}`}
                            >{course.classes.name}</Link>
                        </Text>
                    </HStack>
                    <HStack
                        width="100%"
                    >
                        {LinkItems(course.class_id).filter((link) => (!link.instructor_only || isInstructor) && (!link.student_only || !isInstructor)).map((link) => {
                            if (link.submenu) {
                                return <Box key={link.name}
                                    borderBottom={pathname.startsWith(link.target || '#') ? "3px solid" : "none"}
                                    borderColor="orange.600"
                                >
                                    <Menu.Root>
                                        <Menu.Trigger asChild>
                                            <Button
                                                colorPalette="gray"
                                                _hover={{
                                                    bg: "#EBEDEF"
                                                }}
                                                size="xs"
                                                fontSize="sm"
                                                pt="0"
                                                // href={link.target || '#'}
                                                // style={{ textDecoration: 'none' }}
                                                variant="ghost"
                                                asChild
                                            >
                                                <Flex
                                                    align="center"
                                                    role="group"
                                                >
                                                    <HStack>
                                                        {React.createElement(link.icon)}
                                                        {link.name}</HStack>
                                                </Flex>
                                            </Button>
                                        </Menu.Trigger>
                                        <Portal>
                                            <Menu.Positioner>
                                                <Menu.Content>
                                                    {link.submenu.map((submenu) => (
                                                        <Menu.Item key={submenu.name} value={submenu.name} asChild>
                                                            <NextLink prefetch={true} href={submenu.target || '#'}>
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
                            } else {
                                return <Box key={link.name}
                                    borderBottom={pathname.startsWith(link.target || '#') ? "3px solid" : "none"}
                                    borderColor="orange.600"
                                >
                                    <Button
                                        colorPalette="gray"
                                        _hover={{
                                            bg: "#EBEDEF"
                                        }}
                                        size="xs"
                                        fontSize="sm"
                                        pt="0"
                                        // href={link.target || '#'}
                                        // style={{ textDecoration: 'none' }}
                                        variant="ghost"
                                        asChild
                                    >
                                        <NextLink prefetch={true} href={link.target || '#'}>
                                            <Flex
                                                align="center"
                                                role="group"
                                            >
                                                <HStack>
                                                    {React.createElement(link.icon)}
                                                    {link.name}</HStack>
                                            </Flex>
                                        </NextLink>
                                    </Button></Box>
                            }
                        })}
                    </HStack>
                </VStack>
                <UserMenu />
            </Flex>
        </Box>
    )
}