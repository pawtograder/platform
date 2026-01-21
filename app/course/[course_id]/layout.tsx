import { Box } from "@chakra-ui/react";

import React from "react";

import { FloatingHelpRequestWidget } from "@/components/help-queue/floating-help-request-widget";
import { NavigationProgressProvider } from "@/components/ui/navigation-progress";
import { CourseControllerProvider } from "@/hooks/useCourseController";
import { OfficeHoursControllerProvider } from "@/hooks/useOfficeHoursRealtime";
import { fetchCourseControllerData, getCourse, getUserRolesForCourse } from "@/lib/ssrUtils";
import { TimeZoneProvider } from "@/lib/TimeZoneProvider";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import DynamicCourseNav from "./dynamicCourseNav";

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
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  const user_role = await getUserRolesForCourse(Number.parseInt(course_id), user_id);
  if (!user_role) {
    redirect("/");
  }

  // Pre-fetch all course controller data on the server with caching
  const initialData = await fetchCourseControllerData(Number.parseInt(course_id), user_role.role);

  // Get course information for timezone
  const course = await getCourse(Number.parseInt(course_id));
  const courseTimeZone = course?.time_zone || "America/New_York";

  return (
    <Box minH="100vh">
      <NavigationProgressProvider>
        <TimeZoneProvider courseTimeZone={courseTimeZone}>
          <CourseControllerProvider
            course_id={Number.parseInt(course_id)}
            profile_id={user_role.private_profile_id}
            role={user_role.role}
            initialData={initialData}
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
              <FloatingHelpRequestWidget />
            </OfficeHoursControllerProvider>
          </CourseControllerProvider>
        </TimeZoneProvider>
      </NavigationProgressProvider>
    </Box>
  );
};

export default ProtectedLayout;
