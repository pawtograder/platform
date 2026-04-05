import { Box, Skeleton, SkeletonText, Stack } from "@chakra-ui/react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getUserRolesForCourse } from "@/lib/ssrUtils";
import InstructorDashboard from "./instructorDashboard";
import StudentDashboard from "./studentDashboard";

function CourseHomeDashboardFallback() {
  return (
    <Box p={2}>
      <Stack gap={4}>
        <Skeleton height="28px" width="45%" maxW="320px" borderRadius="md" />
        <Skeleton height="100px" borderRadius="md" />
        <SkeletonText noOfLines={5} gap={3} />
        <Skeleton height="180px" borderRadius="md" />
      </Stack>
    </Box>
  );
}

export default async function CourseLanding({ params }: { params: Promise<{ course_id: string }> }) {
  const course_id = Number.parseInt((await params).course_id);
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }

  const role = await getUserRolesForCourse(course_id, user_id);
  if (role?.role === "instructor" || role?.role === "grader") {
    return (
      <Box>
        <Suspense fallback={<CourseHomeDashboardFallback />}>
          <InstructorDashboard course_id={course_id} />
        </Suspense>
      </Box>
    );
  }
  if (!role?.private_profile_id) {
    throw new Error("No private profile id found");
  }
  const private_profile_id = role.private_profile_id;
  return (
    <Box>
      <Suspense fallback={<CourseHomeDashboardFallback />}>
        <StudentDashboard course_id={course_id} private_profile_id={private_profile_id} />
      </Suspense>
    </Box>
  );
}
