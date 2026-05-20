"use client";

import { Alert } from "@/components/ui/alert";
import { useRegradeRequestsBySubmission, useRubricCheck } from "@/hooks/useAssignment";
import type { RegradeRequest, RegradeStatus } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Heading, HStack, Icon, Link as ChakraLink, Text, VStack } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { AlertCircle, ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";

// Mirror of statusConfig used across the regrade request UIs (InstructorRegradeTableShared,
// RegradeRequestsTable). Kept local so this panel renders consistent status badges.
const statusConfig: Record<RegradeStatus, { colorPalette: string; icon: LucideIcon; label: string }> = {
  draft: { colorPalette: "gray", icon: Clock, label: "Draft" },
  opened: { colorPalette: "orange", icon: AlertCircle, label: "Pending" },
  resolved: { colorPalette: "blue", icon: CheckCircle, label: "Resolved" },
  escalated: { colorPalette: "red", icon: ArrowUp, label: "Escalated" },
  closed: { colorPalette: "gray", icon: XCircle, label: "Closed" }
};

const ACTIVE_STATUSES: RegradeStatus[] = ["draft", "opened", "escalated"];

function isActive(status: RegradeStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * A single regrade request row showing its status, the rubric check it references,
 * the point movement, timestamps, and a deep link to the request on the submission page.
 */
function RegradeRequestRow({ request }: { request: RegradeRequest }) {
  const rubricCheck = useRubricCheck(request.rubric_check_id);
  const config = statusConfig[request.status as RegradeStatus] ?? statusConfig.opened;
  const StatusIcon = config.icon;

  // Final points: prefer instructor's closed_points, fall back to grader's resolved_points.
  const finalPoints = request.closed_points ?? request.resolved_points;
  const isDangling = request.resolution_reason === "comment_deleted";

  return (
    <Box
      // Dangling requests have no backing comment in the rubric sidebar, so this panel row
      // is the canonical anchor for them. Non-dangling requests are anchored on their
      // sidebar comment (same id), so we must not duplicate that id here.
      id={isDangling ? `regrade-request-${request.id}` : undefined}
      borderWidth="1px"
      borderColor={isDangling ? "border.warning" : "border.subtle"}
      borderRadius="md"
      p={2}
      w="100%"
    >
      <HStack justify="space-between" align="start" flexWrap="wrap" gap={2}>
        <VStack align="start" gap={1} flex="1" minW="0">
          <HStack gap={2} flexWrap="wrap">
            <Badge colorPalette={config.colorPalette} size="sm">
              <HStack gap={1}>
                <Icon as={StatusIcon} boxSize={3} />
                <Text>{config.label}</Text>
              </HStack>
            </Badge>
            <Text fontSize="sm" fontWeight="medium">
              {rubricCheck?.name ?? "General"}
            </Text>
          </HStack>
          <HStack gap={3} flexWrap="wrap" fontSize="xs" color="fg.muted">
            <Text>
              Initial:{" "}
              <Text as="span" fontWeight="semibold" color="fg.default">
                {request.initial_points ?? "-"}
              </Text>
            </Text>
            <Text>
              Final:{" "}
              <Text as="span" fontWeight="semibold" color="fg.default">
                {finalPoints ?? "-"}
              </Text>
            </Text>
          </HStack>
          <HStack gap={3} flexWrap="wrap" fontSize="xs" color="fg.muted">
            <Text>Created {formatRelative(new Date(request.created_at), new Date())}</Text>
            <Text>Updated {formatRelative(new Date(request.last_updated_at), new Date())}</Text>
          </HStack>
        </VStack>
        {!isDangling && (
          <ChakraLink href={`#regrade-request-${request.id}`} fontSize="sm" colorPalette="blue">
            View
          </ChakraLink>
        )}
      </HStack>
      {isDangling && (
        <Box mt={2}>
          <Alert status="warning" title="Action needed">
            The grade this request referenced was changed during re-grading — review the updated grade and escalate if
            you still disagree.
          </Alert>
        </Box>
      )}
    </Box>
  );
}

/**
 * Lists all regrade requests for a single submission, grouped together independently of
 * whether each request's underlying comment is currently rendered on the page. Active requests
 * (draft/opened/escalated) are shown first, followed by resolved/closed ones. Auto-resolved
 * "dangling" requests (resolution_reason === "comment_deleted") surface a visible banner.
 *
 * Renders nothing when there are no regrade requests for the submission.
 */
export default function SubmissionRegradeRequestsPanel({ submissionId }: { submissionId: number }) {
  const requests = useRegradeRequestsBySubmission(submissionId);

  const sortedRequests = useMemo(() => {
    return [...(requests ?? [])].sort((a, b) => {
      const aActive = isActive(a.status as RegradeStatus);
      const bActive = isActive(b.status as RegradeStatus);
      if (aActive !== bActive) {
        // Active requests come first
        return aActive ? -1 : 1;
      }
      // Same category, newest first
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [requests]);

  if (!sortedRequests || sortedRequests.length === 0) {
    return null;
  }

  return (
    <Box w="100%">
      <Heading as="h2" size="sm" mb={2}>
        Regrade Requests ({sortedRequests.length})
      </Heading>
      <VStack align="stretch" gap={2}>
        {sortedRequests.map((request) => (
          <RegradeRequestRow key={request.id} request={request} />
        ))}
      </VStack>
    </Box>
  );
}
