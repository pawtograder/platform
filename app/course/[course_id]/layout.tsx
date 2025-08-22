// 'use client'

import { Box } from "@chakra-ui/react";

import React from "react";

import { CourseControllerProvider } from "@/hooks/useCourseController";
import { OfficeHoursControllerProvider } from "@/hooks/useOfficeHoursRealtime";
import { redirect } from "next/navigation";
import DynamicCourseNav from "./dynamicCourseNav";
import { getUserRolesForCourse } from "@/lib/ssrUtils";

const ProtectedLayout = async ({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}>) => {
  const { course_id } = await params;
  const user_role = await getUserRolesForCourse(Number.parseInt(course_id));
  console.log(user_role);
  if (!user_role) {
    redirect("/");
  }
  // const {open, onOpen, onClose} = useDisclosure()
  return (
    <Box minH="100vh">
      <CourseControllerProvider
        course_id={Number.parseInt(course_id)}
        profile_id={user_role.private_profile_id}
        role={user_role.role}
      >
        <OfficeHoursControllerProvider
          classId={Number.parseInt(course_id)}
          profileId={user_role.private_profile_id}
          role={user_role.role}
        >
          <DynamicCourseNav />
          {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
          {/* mobilenav */}
          <Box pt="0" ml="0" mr="0">
            {children}
          </Box>
        </OfficeHoursControllerProvider>
      </CourseControllerProvider>
    </Box>
  );
};

export default ProtectedLayout;
