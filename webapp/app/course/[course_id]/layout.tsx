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
    const { data: classData } = await supabase.from('classes').select('*').eq('id', Number.parseInt(course_id)).single();
    const { data: user } = await supabase.auth.getUser();
    if (!user?.user) {
        return <div>Not logged in (TODO redirect to login from layout)</div>
    }

    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <AuthStateProvider user={user?.user}>
            <Box minH="100vh">
                <DynamicCourseNav course={classData} />
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