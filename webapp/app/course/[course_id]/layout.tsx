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
    // const roles = jwt.roles as UserRole[];
    const {data : courses} = await supabase.from("user_roles").select('*, classes(*)'); 
    if (!user?.user) {
        return <div>Not logged in (TODO redirect to login from layout)</div>
    }
    //
    const currentCourse = courses?.find(c => c.classes?.id === Number.parseInt(course_id));
    if (!currentCourse|| !courses) {
        return <NotFound />
    }
    if(!currentCourse.public_profile_id || !currentCourse.private_profile_id) {
        return <Alert.Root status="error">No public or private profile id for course {course_id}</Alert.Root>
    }
    const instructor = await isInstructor(Number.parseInt(course_id));
    // const {open, onOpen, onClose} = useDisclosure()
    return (
        <AuthStateProvider user={user?.user} isInstructor={instructor} roles={courses} public_profile_id={currentCourse.public_profile_id} private_profile_id={currentCourse.private_profile_id}>
            <Box minH="100vh">
                <DynamicCourseNav courses={courses} course={currentCourse!.classes} />
                {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
                {/* mobilenav */}
                <Box pt="0" pl="4" pr="4">
                    {children}
                </Box>
            </Box>
        </AuthStateProvider>
    )
}

export default ProtectedLayout