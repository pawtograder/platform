import { Box } from "@chakra-ui/react";
import InstructorDashboard from "./instructorDashboard";
import StudentDashboard from "./studentDashboard";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserRolesForCourse } from "@/lib/ssrUtils";

export default async function CourseLanding({ params }: { params: Promise<{ course_id: string }> }) {
  const course_id = Number.parseInt((await params).course_id);
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }

  const role = await getUserRolesForCourse(course_id, user_id);
  if (role?.role === "instructor") {
    return (
      <Box>
        <InstructorDashboard course_id={course_id} />
      </Box>
    );
  }
  return (
    <Box>
      <StudentDashboard course_id={course_id} />
    </Box>
  );
}
