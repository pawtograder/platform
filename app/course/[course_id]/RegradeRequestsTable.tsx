"use client";

import { Badge, Box, HStack, Icon, Table, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { AlertCircle, ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import Link from "next/link";

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

export default function RegradeRequestsTable({
  regradeRequests,
  courseId
}: {
  regradeRequests: RegradeRequest[];
  courseId: number;
}) {
  // Sort regrade requests so closed/resolved are at bottom
  const sortedRegradeRequests = [...regradeRequests].sort((a, b) => {
    const aIsClosed = a.status === "resolved" || a.status === "closed";
    const bIsClosed = b.status === "resolved" || b.status === "closed";
    if (aIsClosed === bIsClosed) {
      // Same category, sort by date (newest first)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    // Open requests come first
    return aIsClosed ? 1 : -1;
  });

  if (!sortedRegradeRequests || sortedRegradeRequests.length === 0) {
    return <Text color="fg.muted">No regrade requests</Text>;
  }

  return (
    <Box overflowX="auto">
      <Table.Root size="sm">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Status</Table.ColumnHeader>
            <Table.ColumnHeader>Assignment</Table.ColumnHeader>
            <Table.ColumnHeader>Submission</Table.ColumnHeader>
            <Table.ColumnHeader>Rubric Check</Table.ColumnHeader>
            <Table.ColumnHeader>Initial Points</Table.ColumnHeader>
            <Table.ColumnHeader>Final Points</Table.ColumnHeader>
            <Table.ColumnHeader>Created</Table.ColumnHeader>
            <Table.ColumnHeader>Last Updated</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sortedRegradeRequests.map((request) => {
            const statusConfig = {
              draft: { label: "Draft", colorPalette: "gray", icon: Clock },
              opened: { label: "Pending", colorPalette: "orange", icon: AlertCircle },
              escalated: { label: "Escalated", colorPalette: "red", icon: ArrowUp },
              resolved: { label: "Resolved", colorPalette: "blue", icon: CheckCircle },
              closed: { label: "Closed", colorPalette: "gray", icon: XCircle }
            };
            const config = statusConfig[request.status as keyof typeof statusConfig];
            const StatusIcon = config?.icon;

            const finalPoints =
              request.status === "closed" && request.closed_points !== null
                ? request.closed_points
                : request.resolved_points;

            // Get rubric check name from the first available comment
            const rubricCheckName =
              request.submission_file_comments?.[0]?.rubric_checks?.name ||
              request.submission_artifact_comments?.[0]?.rubric_checks?.name ||
              request.submission_comments?.[0]?.rubric_checks?.name ||
              "-";

            return (
              <Table.Row key={request.id}>
                <Table.Cell>
                  <Badge colorPalette={config?.colorPalette || "gray"} size="sm">
                    <HStack gap={1}>
                      {StatusIcon && <Icon as={StatusIcon} boxSize={3} />}
                      <Text>{config?.label || request.status}</Text>
                    </HStack>
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <Link
                    href={`/course/${courseId}/assignments/${request.assignment_id}/submissions/${request.submission_id}#regrade-request-${request.id}`}
                  >
                    <Text color="blue.500" textDecoration="underline">
                      {request.assignments?.title || "Unknown"}
                    </Text>
                  </Link>
                </Table.Cell>
                <Table.Cell>#{request.submissions?.ordinal || "?"}</Table.Cell>
                <Table.Cell>{rubricCheckName}</Table.Cell>
                <Table.Cell>{request.initial_points ?? "-"}</Table.Cell>
                <Table.Cell>{finalPoints ?? "-"}</Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm">{formatRelative(new Date(request.created_at), new Date())}</Text>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm">{formatRelative(new Date(request.last_updated_at), new Date())}</Text>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
