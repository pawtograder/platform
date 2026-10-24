import { SubmissionHeaderChrome } from "./submissionHeaderChrome";
import { getEffectiveCourseIdentity } from "@/lib/ssrUtils";
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
  const role = await getEffectiveCourseIdentity(Number(course_id), user_id);
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
        <SubmissionHeaderChrome
          assignment={assignment}
          courseId={Number(course_id)}
          assignmentId={Number(assignment_id)}
          slot="due-date"
        />
      </HStack>
      <SubmissionHeaderChrome
        assignment={assignment}
        courseId={Number(course_id)}
        assignmentId={Number(assignment_id)}
        slot="below-header"
      />

      <Box borderColor="border.muted" borderWidth="2px" w="100%" borderTopRadius={0} borderBottomRadius="md">
        {children}
      </Box>
    </VStack>
  );
}
