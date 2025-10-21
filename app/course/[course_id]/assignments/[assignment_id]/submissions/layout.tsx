import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import AssignmentGradingToolbar from "@/components/ui/assignment-grading-toolbar";
import { getUserRolesForCourse } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/server";
import { Box, Heading, HStack, VStack } from "@chakra-ui/react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function SubmissionsLayout({
  params,
  children
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
  children: React.ReactNode;
}) {
  const { course_id, assignment_id } = await params;
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  const role = await getUserRolesForCourse(Number(course_id), user_id);
  if (!role) {
    redirect("/");
  }

  const client = await createClient();
  const { data: assignment } = await client
    .from("assignments")
    .select("*")
    .eq("id", Number(assignment_id))
    .eq("class_id", Number(course_id))
    .single();
  if (!assignment) {
    return <div>Assignment not found</div>;
  }

  const instructorOrGrader = role.role === "instructor" || role.role === "grader";
  return (
    <VStack w="100%" gap={0} alignItems="flex-start">
      <HStack
        w="100%"
        mt={2}
        justifyContent="space-between"
        bg="bg.muted"
        p={2}
        borderTopRadius="md"
        borderBottomRadius={0}
      >
        <Heading size="lg">{assignment?.title}</Heading>
        {!instructorOrGrader && (
          <AssignmentDueDate assignment={assignment} showLateTokenButton={true} showTimeZone={true} showDue={true} />
        )}
      </HStack>
      {instructorOrGrader && <AssignmentGradingToolbar />}

      <Box borderColor="border.muted" borderWidth="2px" w="100%" borderTopRadius={0} borderBottomRadius="md">
        {children}
      </Box>
    </VStack>
  );
}
