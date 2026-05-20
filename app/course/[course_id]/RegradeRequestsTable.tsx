"use client";

import { Badge, Box, Collapsible, HStack, Icon, Table, Text, VStack } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { AlertCircle, AlertTriangle, ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import Link from "next/link";
import { useMemo } from "react";
import type { RegradeRequestWithDetails } from "@/utils/supabase/DatabaseTypes";
import { useRubricCheck } from "@/hooks/useAssignment";

const statusConfig = {
  draft: { label: "Draft", colorPalette: "gray", icon: Clock },
  opened: { label: "Pending", colorPalette: "orange", icon: AlertCircle },
  escalated: { label: "Escalated", colorPalette: "red", icon: ArrowUp },
  resolved: { label: "Resolved", colorPalette: "blue", icon: CheckCircle },
  closed: { label: "Closed", colorPalette: "gray", icon: XCircle }
};

function isClosed(status: string): boolean {
  return status === "resolved" || status === "closed";
}

function sortRequests(requests: RegradeRequestWithDetails[]): RegradeRequestWithDetails[] {
  return [...requests].sort((a, b) => {
    const aIsClosed = isClosed(a.status);
    const bIsClosed = isClosed(b.status);
    if (aIsClosed === bIsClosed) {
      // Same category, sort by date (newest first)
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    // Open requests come first
    return aIsClosed ? 1 : -1;
  });
}

type SubmissionGroup = {
  submissionId: number;
  assignmentId: number | null;
  assignmentTitle: string;
  ordinal: number | string;
  requests: RegradeRequestWithDetails[];
  actionNeededCount: number;
};

function RequestRow({ request, courseId }: { request: RegradeRequestWithDetails; courseId: number }) {
  const config = statusConfig[request.status as keyof typeof statusConfig];
  const StatusIcon = config?.icon;
  const rubricCheckFromId = useRubricCheck(request.rubric_check_id);

  const finalPoints =
    request.status === "closed" && request.closed_points !== null ? request.closed_points : request.resolved_points;

  // Get rubric check name from the first available comment, or fall back to rubric_check_id on the request row.
  const rubricCheckName =
    request.submission_file_comments?.[0]?.rubric_checks?.name ||
    request.submission_artifact_comments?.[0]?.rubric_checks?.name ||
    request.submission_comments?.[0]?.rubric_checks?.name ||
    rubricCheckFromId?.name ||
    "-";

  const isDangling = request.resolution_reason === "comment_deleted";

  return (
    <Table.Row key={request.id}>
      <Table.Cell>
        <HStack gap={2}>
          <Badge colorPalette={config?.colorPalette || "gray"} size="sm">
            <HStack gap={1}>
              {StatusIcon && <Icon as={StatusIcon} boxSize={3} />}
              <Text>{config?.label || request.status}</Text>
            </HStack>
          </Badge>
          {isDangling && (
            <Badge colorPalette="orange" size="sm" variant="surface">
              <HStack gap={1}>
                <Icon as={AlertTriangle} boxSize={3} />
                <Text>Action needed</Text>
              </HStack>
            </Badge>
          )}
        </HStack>
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
}

function SubmissionGroupSection({ group, courseId }: { group: SubmissionGroup; courseId: number }) {
  const requestCount = group.requests.length;
  return (
    <Collapsible.Root defaultOpen>
      <Collapsible.Trigger asChild>
        <HStack
          cursor="pointer"
          role="button"
          tabIndex={0}
          w="100%"
          justify="space-between"
          bg="bg.subtle"
          px={3}
          py={2}
          borderWidth="1px"
          borderColor="border.subtle"
          borderRadius="md"
          _hover={{ bg: "bg.muted" }}
        >
          <HStack gap={2} flexWrap="wrap">
            <Collapsible.Context>
              {(collapsible) => <Icon as={collapsible.open ? LuChevronDown : LuChevronRight} fontSize="sm" />}
            </Collapsible.Context>
            <Text fontWeight="semibold">{group.assignmentTitle}</Text>
            <Text color="fg.muted">
              {requestCount} {requestCount === 1 ? "request" : "requests"} on Submission #{group.ordinal}
            </Text>
            <Badge colorPalette="gray" size="sm">
              {requestCount}
            </Badge>
            {group.actionNeededCount > 0 && (
              <Badge colorPalette="orange" size="sm" variant="surface">
                <HStack gap={1}>
                  <Icon as={AlertTriangle} boxSize={3} />
                  <Text>
                    {group.actionNeededCount} action{group.actionNeededCount === 1 ? "" : "s"} needed
                  </Text>
                </HStack>
              </Badge>
            )}
          </HStack>
        </HStack>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Box overflowX="auto" mt={1}>
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
              {group.requests.map((request) => (
                <RequestRow key={request.id} request={request} courseId={courseId} />
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export default function RegradeRequestsTable({
  regradeRequests,
  courseId
}: {
  regradeRequests: RegradeRequestWithDetails[];
  courseId: number;
}) {
  // Group requests by submission_id, then order groups so those containing active requests
  // (and the most recently updated) bubble to the top.
  const groups = useMemo<SubmissionGroup[]>(() => {
    const bySubmission = new Map<number, SubmissionGroup>();
    for (const request of regradeRequests) {
      let group = bySubmission.get(request.submission_id);
      if (!group) {
        group = {
          submissionId: request.submission_id,
          assignmentId: request.assignment_id,
          assignmentTitle: request.assignments?.title || "Unknown",
          ordinal: request.submissions?.ordinal ?? "?",
          requests: [],
          actionNeededCount: 0
        };
        bySubmission.set(request.submission_id, group);
      }
      group.requests.push(request);
      if (request.resolution_reason === "comment_deleted") {
        group.actionNeededCount += 1;
      }
    }

    const groupList = Array.from(bySubmission.values());
    for (const group of groupList) {
      group.requests = sortRequests(group.requests);
    }

    return groupList.sort((a, b) => {
      const aHasActive = a.requests.some((r) => !isClosed(r.status));
      const bHasActive = b.requests.some((r) => !isClosed(r.status));
      if (aHasActive !== bHasActive) {
        return aHasActive ? -1 : 1;
      }
      // Most recently updated submission first
      const aLatest = Math.max(...a.requests.map((r) => new Date(r.last_updated_at).getTime()));
      const bLatest = Math.max(...b.requests.map((r) => new Date(r.last_updated_at).getTime()));
      return bLatest - aLatest;
    });
  }, [regradeRequests]);

  if (!groups || groups.length === 0) {
    return <Text color="fg.muted">No regrade requests</Text>;
  }

  return (
    <VStack align="stretch" gap={3}>
      {groups.map((group) => (
        <SubmissionGroupSection key={group.submissionId} group={group} courseId={courseId} />
      ))}
    </VStack>
  );
}
