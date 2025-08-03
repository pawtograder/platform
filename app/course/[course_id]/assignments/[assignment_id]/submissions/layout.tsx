import AssignmentGradingToolbar from "@/components/ui/assignment-grading-toolbar";
import { isInstructorOrGrader } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/server";
import { Box, Heading, HStack, VStack } from "@chakra-ui/react";

export default async function SubmissionsLayout({
  params,
  children
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
  children: React.ReactNode;
}) {
  const { course_id, assignment_id } = await params;
  const client = await createClient();
  const { data: assignment } = await client
    .from("assignments")
    .select("*, assignment_self_review_settings(*)")
    .eq("id", Number(assignment_id))
    .single();
  const showGradingToolbar = await isInstructorOrGrader(Number(course_id));
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
      </HStack>
      {showGradingToolbar && <AssignmentGradingToolbar />}

      <Box borderColor="border.muted" borderWidth="2px" w="100%" borderTopRadius={0} borderBottomRadius="md">
        {children}
      </Box>
    </VStack>
  );
}
