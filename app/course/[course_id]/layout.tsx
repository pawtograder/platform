// 'use client'

import { Box } from "@chakra-ui/react";

import React from "react";

import { CourseControllerProvider } from "@/hooks/useCourseController";
import { OfficeHoursControllerProvider } from "@/hooks/useOfficeHoursRealtime";
import { redirect } from "next/navigation";
import DynamicCourseNav from "./dynamicCourseNav";
import { getCourse, getUserRolesForCourse } from "@/lib/ssrUtils";
import { cookies } from "next/headers";

type TimeZonePreference = "course" | "browser";

function getCookieKey(courseId: number): string {
  return `tz_pref_course_${courseId}`;
}

export async function generateMetadata({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const course = await getCourse(Number(course_id));
  return {
    title: `${course?.course_title || course?.name || "Course"} - Pawtograder`
  };
}

const ProtectedLayout = async ({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ course_id: string }>;
}>) => {
  const { course_id } = await params;
  const user_role = await getUserRolesForCourse(Number.parseInt(course_id));
  if (!user_role) {
    redirect("/");
  }
  // Seed initial time zone preference from server cookie (if set)
  const cookieStore = await cookies();
  const key = getCookieKey(Number.parseInt(course_id));
  const pref = cookieStore.get(key)?.value as TimeZonePreference | undefined;
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
          <DynamicCourseNav initialTimeZonePreference={pref} />
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
