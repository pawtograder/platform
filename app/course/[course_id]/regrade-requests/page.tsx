"use client";

import { Box, Heading, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import type { RegradeRequestWithDetails } from "@/utils/supabase/DatabaseTypes";
import RegradeRequestsTable from "../RegradeRequestsTable";
import { toaster } from "@/components/ui/toaster";
import * as Sentry from "@sentry/nextjs";

export default function StudentRegradeRequestsPage() {
  const { course_id } = useParams();
  const [regradeRequests, setRegradeRequests] = useState<RegradeRequestWithDetails[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRegradeRequests() {
      const supabase = createClient();
      try {
        const { data, error } = await supabase
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

        if (error) {
          throw error;
        }

        setRegradeRequests(data || []);
        setError(null);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Failed to load regrade requests";

        // Log to Sentry with context
        Sentry.withScope((scope) => {
          scope.setContext("regrade_requests_fetch", {
            course_id: Number(course_id),
            error: errorMessage
          });
          Sentry.captureException(error);
        });

        // Show user-friendly error message
        toaster.error({
          title: "Error loading regrade requests",
          description: errorMessage
        });

        setError(errorMessage);
        setRegradeRequests([]);
      } finally {
        setIsLoading(false);
      }
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
      ) : error ? (
        <Box>
          <Text color="red.500">Error: {error}</Text>
        </Box>
      ) : (
        <RegradeRequestsTable regradeRequests={regradeRequests} courseId={Number(course_id)} />
      )}
    </VStack>
  );
}
