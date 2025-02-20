'use client'

import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Flex, HStack, Skeleton, VStack } from "@chakra-ui/react";
import { usePathname, useRouter } from "next/navigation";
import {
    FiBook,
    FiCalendar,
    FiCompass,
    FiHome,
    FiMessageSquare,
    FiSettings,
    FiStar,
    FiTrendingUp
} from 'react-icons/fi'
import UserMenu from "../UserMenu";
import React, { useEffect } from "react";

const LinkItems = (courseID: number) => ([
    { name: 'Assignments', icon: FiCompass, target: `/course/${courseID}/assignments` },
    { name: 'Discussion', icon: FiStar, target: `/course/${courseID}/discussion` },
    { name: 'Flashcards', icon: FiBook, target: `/course/${courseID}/flashcards` },
    { name: 'Get Help Now', icon: FiMessageSquare, target: `/course/${courseID}/help` },
    // {name: 'Trending', icon: FiTrendingUp },
    // {name: 'Explore', icon: FiCompass },
    // {name: 'Favourites', icon: FiStar },
    { name: 'Settings', icon: FiSettings },
]);

export default function DynamicCourseNav({ course }: { course: null | Database['public']['Tables']['classes']['Row'] }) {
    const router = useRouter();
    const pathname = usePathname();
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
                >{course.name}</Box>
                <UserMenu />
            </Flex>
            <HStack
                width="100%"
            >
                {LinkItems(course.id).map((link) => (
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