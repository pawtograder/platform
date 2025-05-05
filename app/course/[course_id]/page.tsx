import { isInstructor } from "@/lib/ssrUtils";
import { Box } from "@chakra-ui/react";
import InstructorDashboard from "./instructorDashboard";
import StudentDashboard from "./studentDashboard";

export default async function CourseLanding({ params }: { params: Promise<{ course_id: string }> }) {
  const course_id = Number.parseInt((await params).course_id);

  const instructor = await isInstructor(course_id);
  if (instructor) {
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
