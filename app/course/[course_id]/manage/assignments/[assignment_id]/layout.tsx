'use client'
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, Heading, HStack, Menu, VStack } from "@chakra-ui/react";
import { useOne } from "@refinedev/core";
import { useParams, usePathname } from "next/navigation";
import { FaCalendar, FaCode, FaEdit, FaGithub, FaHome, FaPen, FaPlay, FaUsers } from "react-icons/fa";
import NextLink from "next/link";
import React from "react";
import { CreateGitHubRepos } from "./CreateGitHubRepos";
const LinkItems = (courseId: number, assignmentId: number) => ([
    {
        label: "Assignment Home",
        href: `/course/${courseId}/manage/assignments/${assignmentId}`,
        icon: FaHome
    },
    {
        label: "Edit Assignment",
        href: `/course/${courseId}/manage/assignments/${assignmentId}/edit`,
        icon: FaEdit
    },
    {
        label: "Configure Autograder",
        href: `/course/${courseId}/manage/assignments/${assignmentId}/autograder`,
        icon: FaCode
    },
    {
        label: "Configure Rubric",
        href: `/course/${courseId}/manage/assignments/${assignmentId}/rubric`,
        icon: FaPen
    },
    {
        label: "Manage Due Date Exceptions",
        href: `/course/${courseId}/manage/assignments/${assignmentId}/due-date-exceptions`,
        icon: FaCalendar
    },
    {
        label: "Manage Groups",
        href: `/course/${courseId}/manage/assignments/${assignmentId}/groups`,
        icon: FaUsers
    },
    {
        label: "Test Assignment",
        href: `/course/${courseId}/manage/assignments/${assignmentId}/test`,
        icon: FaPlay
    }
])
export default function AssignmentLayout({ children }: { children: React.ReactNode }) {
    const { course_id, assignment_id } = useParams();
    const { data: assignment } = useOne<Assignment>({ resource: "assignments", id: Number.parseInt(assignment_id as string) });
    const pathname = usePathname();
    return (
        <Flex pt={4}>
            <Box w="xs" pr={2} flex={0}>
                <VStack align="flex-start">
                    {LinkItems(Number.parseInt(course_id as string), Number.parseInt(assignment_id as string)).map((item) => (
                        <Button key={item.label} variant={pathname.endsWith(item.href) ? "solid" : "ghost"}
                            w="100%"
                            size="xs"
                            pt="0"
                            fontSize="sm"
                            justifyContent="flex-start"
                            asChild>
                            <NextLink href={item.href} prefetch={true} legacyBehavior>
                                <HStack textAlign="left" w="100%" justify="flex-start">
                                    {React.createElement(item.icon)}
                                    {item.label}</HStack>
                            </NextLink>
                        </Button>
                    ))}
                    <CreateGitHubRepos courseId={Number.parseInt(course_id as string)} assignmentId={Number.parseInt(assignment_id as string)} />
                </VStack>
            </Box>
            <Box borderColor="border.muted"
                borderWidth="2px"
                borderRadius="md"
                p={4}
                flexGrow={1}
            >
                <Heading size="lg">Assignment: {assignment ? assignment.data?.title : "Loading..."}</Heading>
                <Box>
                    {children}
                </Box>
            </Box>
        </Flex >
    );
}
