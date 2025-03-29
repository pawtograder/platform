// 'use client'

import {
    Box
} from '@chakra-ui/react'


import React from 'react'

import { CourseControllerProvider } from '@/hooks/useCourseController'
import DynamicCourseNav from './dynamicCourseNav'

const ProtectedLayout = async ({ children, params }: Readonly<{
    children: React.ReactNode;
    params: Promise<{ course_id: string }>
}>) => {
    const {course_id} = await params;
    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <Box minH="100vh">
            <CourseControllerProvider course_id={Number.parseInt(course_id)}>
                <DynamicCourseNav />
                {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
                {/* mobilenav */}
                <Box pt="0" pl="4" pr="4">
                    {children}
                </Box>
            </CourseControllerProvider>
        </Box>
    )
}

export default ProtectedLayout