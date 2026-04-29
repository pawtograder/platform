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
import { HelpDrawerProvider } from "@/hooks/useHelpDrawer";
import { KeyboardShortcutsProvider } from "@/hooks/useKeyboardShortcuts";

export async function generateMetadata({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const course = await getCourse(Number(course_id));
  const name = course?.course_title || course?.name || "Course";
  return {
    title: {
      default: `${name} · Pawtograder`,
      template: `%s · ${name} · Pawtograder`
    }
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

  // Staff pages should stream quickly even for very large classes; avoid blocking layout render
  // on a full table prefetch bundle.
  const shouldPrefetchCourseData = user_role.role === "student";
  const initialData = shouldPrefetchCourseData
    ? await fetchCourseControllerData(Number.parseInt(course_id), user_role.role)
    : undefined;

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
              <HelpDrawerProvider>
                <KeyboardShortcutsProvider courseId={Number.parseInt(course_id)}>
                  <DynamicCourseNav />
                  <Box as="main" id="main-content" tabIndex={-1} pt="0" ml="0" mr="0" pb="80px" outline="none">
                    {children}
                  </Box>
                  <FloatingHelpRequestWidget />
                </KeyboardShortcutsProvider>
              </HelpDrawerProvider>
            </OfficeHoursControllerProvider>
          </CourseControllerProvider>
        </TimeZoneProvider>
      </NavigationProgressProvider>
    </Box>
  );
};

export default ProtectedLayout;
