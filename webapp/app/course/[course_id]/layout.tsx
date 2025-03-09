// 'use client'

import {
    Alert,
    Box,
    FlexProps
} from '@chakra-ui/react'


import React from 'react'
import { IconType } from 'react-icons'

import NotFound from '@/components/ui/not-found'
import { AuthStateProvider } from '@/hooks/useAuthState'
import { isInstructor } from '@/lib/ssrUtils'
import { createClient } from '@/utils/supabase/server'
import DynamicCourseNav from './dynamicCourseNav'
import { ClassProfileProvider } from '@/hooks/useClassProfiles'
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

    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <ClassProfileProvider>
            <Box minH="100vh">
                <DynamicCourseNav />
                {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
                {/* mobilenav */}
                <Box pt="0" pl="4" pr="4">
                    {children}
                </Box>
            </Box>
        </ClassProfileProvider>
    )
}

export default ProtectedLayout