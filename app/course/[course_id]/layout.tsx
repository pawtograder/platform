import { Box } from "@chakra-ui/react";

import React from "react";

import { CourseControllerProvider } from "@/hooks/useCourseController";
import { OfficeHoursControllerProvider } from "@/hooks/useOfficeHoursRealtime";
import { redirect } from "next/navigation";
import DynamicCourseNav from "./dynamicCourseNav";
import { getCourse, getUserRolesForCourse, fetchCourseControllerData } from "@/lib/ssrUtils";
import { headers } from "next/headers";
import { NavigationProgressProvider } from "@/components/ui/navigation-progress";
import { FloatingHelpRequestWidget } from "@/components/help-queue/floating-help-request-widget";
import { HelpDrawerProvider } from "@/hooks/useHelpDrawer";

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

  return (
    <Box minH="100vh">
      <NavigationProgressProvider>
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
            <HelpDrawerProvider>
              <DynamicCourseNav />
              {/* <SidebarContent courseID={Number.parseInt(course_id)} /> */}
              {/* mobilenav */}
              <Box pt="0" ml="0" mr="0">
                {children}
              </Box>
              <FloatingHelpRequestWidget />
            </HelpDrawerProvider>
          </OfficeHoursControllerProvider>
        </CourseControllerProvider>
      </NavigationProgressProvider>
    </Box>
  );
};

export default ProtectedLayout;
