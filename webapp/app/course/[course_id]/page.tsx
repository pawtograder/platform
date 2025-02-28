import { CardHeader, CardRoot, CardBody, DataListRoot, DataListItem, DataListItemLabel, DataListItemValue } from "@chakra-ui/react";
import { Stack } from "@chakra-ui/react";
import { Box, Heading } from "@chakra-ui/react";
import { VStack } from "@chakra-ui/react";
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { createClient } from "@/utils/supabase/server";
import Link from "next/link";
import { isInstructor } from "@/lib/ssrUtils";
import StudentDashboard from "./studentDashboard";
import InstructorDashboard from "./instructorDashboard";

export default async function CourseLanding({
  params,
}: {
  params: Promise<{ course_id: string }>
}) {
  const course_id = Number.parseInt((await params).course_id);
  const supabase = await createClient();

  const instructor = await isInstructor(course_id);
  if (instructor) {
    return <Box height="calc(100vh - var(--nav-height))" overflowY="auto">
      <InstructorDashboard course_id={course_id} />
    </Box>
  }
  return <Box height="calc(100vh - var(--nav-height))" overflowY="auto">
    <StudentDashboard course_id={course_id} />
  </Box>
}