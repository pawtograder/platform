'use client'

import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Flex, HStack, Skeleton, VStack, Text } from "@chakra-ui/react";
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
    FiMenu
} from 'react-icons/fi'
import UserMenu from "../UserMenu";
import React, { Fragment, useEffect } from "react";
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
const LinkItems = (courseID: number) => ([
    { name: 'Assignments', icon: FiCompass, target: `/course/${courseID}/assignments` },
    { name: 'Discussion', icon: FiStar, target: `/course/${courseID}/discussion` },
    // { name: 'Flashcards', icon: FiBook, target: `/course/${courseID}/flashcards` },
    { name: 'Get Help Now', student_only: true, icon: FiMessageSquare, target: `/course/${courseID}/help` },
    { name: 'Give Help Now', instructor_only: true, icon: FiClipboard, target: `/course/${courseID}/manage/help` },
    // {name: 'Trending', icon: FiTrendingUp },
    // {name: 'Explore', icon: FiCompass },
    // {name: 'Favourites', icon: FiStar },
    { name: 'Settings', icon: FiSettings },
]);

function CoursePicker({ courses, currentCourse }: { courses: UserRoleWithCourse[], currentCourse: Course }) {
    if(courses.length === 1) {
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
            if(ret !== 0) {
                return ret;
            }
        }
        return a.name!.localeCompare(b.name!);
    }
    return <DrawerRoot size='xs' placement='start'>
    <DrawerBackdrop />
    <DrawerTrigger asChild>
      <Button variant="ghost" colorPalette="gray" size="sm" aria-label="Open course picker">
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
export default function DynamicCourseNav({ course, courses }: { course: null | Course, courses: UserRoleWithCourse[]}) {
    const router = useRouter();
    const pathname = usePathname();
    const { isInstructor } = useAuthState();
    if (!course) {
        return <Skeleton height="40" width="100%" />;
    }
    useEffect(() => {
        LinkItems(course.id).map((link) => {
            router.prefetch(link.target || '#')
        })
    }, [course])
    return (
        <VStack px={{ base: 4, md: 4 }}
            bg='bg.subtle'
            borderBottomWidth="1px"
            borderBottomColor='border.emphasized'>
            <Flex
                width="100%"
                height="20"
                alignItems="center"
                justifyContent={{ base: 'space-between' }}
            >
                
                <Box
                    fontSize="2xl"
                    fontWeight="bold"
                ><CoursePicker courses={courses} currentCourse={course} />
                {course.name}
                </Box>
                <UserMenu />
            </Flex>
            <HStack
                width="100%"
            >
                {LinkItems(course.id).filter((link) => (!link.instructor_only || isInstructor) && (!link.student_only || !isInstructor)).map((link) => (
                    <Box key={link.name} paddingBottom="2"
                        borderBottom={pathname.startsWith(link.target || '#') ? "3px solid" : "none"}
                        borderColor="orange.600"
                    >
                        <Button
                            onClick={() => router.push(link.target || '#')}
                            colorPalette="gray"
                            _hover={{
                                bg: "#EBEDEF"
                            }}
                            fontSize="md"
                            // href={link.target || '#'}
                            // style={{ textDecoration: 'none' }}
                            variant="ghost"
                        >
                            <Flex
                                align="center"
                                role="group"
                            >
                                <HStack>
                                    {React.createElement(link.icon)}
                                    {/* <Icon
                             mr="4"
                             fontSize="16"
                             _groupHover={{
                                 color: 'white',
                             }}
                             as={icon}
                         /> */}
                                    {link.name}</HStack>
                            </Flex>
                        </Button></Box>
                ))}
            </HStack>
        </VStack>
    )
}