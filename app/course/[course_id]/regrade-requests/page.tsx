"use client";

import { Box, Heading, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import RegradeRequestsTable from "../RegradeRequestsTable";

type RegradeRequest = {
  id: number;
  status: string;
  assignment_id: number;
  submission_id: number;
  initial_points: number | null;
  resolved_points: number | null;
  closed_points: number | null;
  created_at: string;
  last_updated_at: string;
  assignments: { id: number; title: string } | null;
  submissions: { id: number; ordinal: number } | null;
  submission_file_comments?: Array<{ rubric_check_id: number | null; rubric_checks: { name: string } | null }> | null;
  submission_artifact_comments?: Array<{
    rubric_check_id: number | null;
    rubric_checks: { name: string } | null;
  }> | null;
  submission_comments?: Array<{ rubric_check_id: number | null; rubric_checks: { name: string } | null }> | null;
};

export default function StudentRegradeRequestsPage() {
  const { course_id } = useParams();
  const [regradeRequests, setRegradeRequests] = useState<RegradeRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchRegradeRequests() {
      const supabase = createClient();
      const { data } = await supabase
        .from("submission_regrade_requests")
        .select(
          `
          *,
          assignments(id, title),
          submissions!inner(id, ordinal),
          submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_file_comments_rubric_check_id_fkey(name)),
          submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_artifact_comments_rubric_check_id_fkey(name)),
          submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_comments_rubric_check_id_fkey(name))
        `
        )
        .eq("class_id", Number(course_id))
        .order("created_at", { ascending: false });

      setRegradeRequests(data || []);
      setIsLoading(false);
    }

    fetchRegradeRequests();
  }, [course_id]);

  return (
    <VStack align="stretch" gap={6} w="100%" p={4}>
      <Box>
        <Heading size="lg">My Regrade Requests</Heading>
        <Text color="fg.muted" fontSize="sm">
          If you feel that a rubric check has been graded incorrectly, you can request a regrade. The request will then
          be marked as &quot;Pending&quot;, and the grader can exchange comments with you to discuss the request. When
          the grader makes their final decision, they will mark the request as &quot;Resolved&quot;. If you are
          unsatisfied with the final decision, you can escalate the request to an instructor.
        </Text>
      </Box>
      {isLoading ? (
        <Box>Loading...</Box>
      ) : (
        <RegradeRequestsTable regradeRequests={regradeRequests} courseId={Number(course_id)} />
      )}
    </VStack>
  );
}
