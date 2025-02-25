// 'use client'

import {
    Box,
    BoxProps,
    Button,
    Flex,
    FlexProps,
    HStack,
    Skeleton,
    Text,
    VStack
} from '@chakra-ui/react'


import React from 'react'
import { IconType } from 'react-icons'

import UserMenu from '../UserMenu'
import Link from 'next/link'
import { useShow } from '@refinedev/core'
import { createClient } from '@/utils/supabase/server'
import { Database } from '@/utils/supabase/SupabaseTypes'
import DynamicCourseNav from './dynamicCourseNav'
import { AuthStateProvider } from '@/hooks/useAuthState'
import { isInstructor } from '@/lib/ssrUtils'
import NotFound from '@/components/ui/not-found'
interface LinkItemProps {
    name: string
    target: string
    icon: IconType
}

interface NavItemProps extends FlexProps {
    icon: IconType
    children: React.ReactNode
}

const ProtectedLayout = async ({ children, params }: Readonly<{
    children: React.ReactNode;
    params: Promise<{ course_id: string }>
}>) => {

    const { course_id } = await params;
    const supabase = await createClient();
    const { data: user } = await supabase.auth.getUser();
    const {data : courses} = await supabase.from("user_roles").select('*, classes(*)');
    if (!user?.user) {
        return <div>Not logged in (TODO redirect to login from layout)</div>
    }
    //
    const currentCourse = courses?.find(c => c.classes?.id === Number.parseInt(course_id));
    if (!currentCourse|| !courses) {
        return <NotFound />
    }
    const instructor = await isInstructor(Number.parseInt(course_id));
    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <AuthStateProvider user={user?.user} isInstructor={instructor}>
            <Box minH="100vh">
                <DynamicCourseNav courses={courses} course={currentCourse!.classes} />
                {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
                {/* mobilenav */}
                <Box ml={{ base: 0, md: 20 }} p="4">
                    {children}
                </Box>
            </Box>
        </AuthStateProvider>
    )
}

export default ProtectedLayout