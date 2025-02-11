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

    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <Box minH="100vh">
            <DynamicCourseNav course={classData} />
            {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
            {/* mobilenav */}
            <Box ml={{ base: 0, md: 20 }} p="4">
                {children}
            </Box>
        </Box>
    )
}

export default ProtectedLayout