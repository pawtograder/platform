"use client";

import Link from "@/components/ui/link";
import { useSubmission } from "@/hooks/useSubmission";
import { createClient } from "@/utils/supabase/client";
import { Tables } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, Flex, HStack, Icon, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import {
  FaCheckCircle,
  FaExclamationCircle,
  FaGithub,
  FaQuestionCircle,
  FaSpinner,
  FaTimesCircle
} from "react-icons/fa";

// `workflow_events` IS in the generated Database type, so its Row is typed
// normally. Only the RPC name `get_submission_checks` is not yet generated; we
// reach it through a localized cast (mirrors the webhook's
// `upsert_github_deployment` call) and drop the cast after the deferred,
// repo-wide type regen.
type WorkflowEvent = Tables<"workflow_events">;

/** Map a workflow_events status/conclusion to a Chakra colorPalette + icon. */
function statusVisual(status: string | null, conclusion: string | null): { color: string; icon: typeof FaGithub } {
  // conclusion is set once the run finishes; status is the live state.
  if (conclusion) {
    switch (conclusion) {
      case "success":
        return { color: "green", icon: FaCheckCircle };
      case "failure":
      case "timed_out":
      case "startup_failure":
        return { color: "red", icon: FaTimesCircle };
      case "cancelled":
      case "skipped":
      case "stale":
      case "neutral":
        return { color: "gray", icon: FaExclamationCircle };
      case "action_required":
        return { color: "yellow", icon: FaExclamationCircle };
      default:
        return { color: "gray", icon: FaQuestionCircle };
    }
  }
  if (status === "completed") {
    return { color: "gray", icon: FaCheckCircle };
  }
  // queued / in_progress / waiting / requested / pending
  return { color: "blue", icon: FaSpinner };
}

/** GitHub Actions run URL for a check, when we have enough to build one. */
function runUrl(check: WorkflowEvent): string | null {
  if (!check.repository_name || !check.workflow_run_id) {
    return null;
  }
  const attempt = check.run_attempt ? `/attempts/${check.run_attempt}` : "";
  return `https://github.com/${check.repository_name}/actions/runs/${check.workflow_run_id}${attempt}`;
}

export default function SubmissionChecksPage() {
  const submission = useSubmission();
  const supabase = useMemo(() => createClient(), []);
  const [checks, setChecks] = useState<WorkflowEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      // types: get_submission_checks not yet in generated Database (deferred regen)
      const { data, error: rpcError } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>
        ) => Promise<{ data: WorkflowEvent[] | null; error: { message: string } | null }>
      )("get_submission_checks", { p_submission_id: submission.id });
      if (!mounted) {
        return;
      }
      if (rpcError) {
        setError(rpcError.message);
        setChecks([]);
      } else {
        // Newest first; the RPC returns rows unordered.
        const sorted = [...(data ?? [])].sort(
          (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
        );
        setChecks(sorted);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [supabase, submission.id]);

  if (loading) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="xl" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Box p={4}>
        <Text color="fg.error">Could not load CI checks: {error}</Text>
      </Box>
    );
  }

  if (checks.length === 0) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="fg.muted">No CI checks for this submission yet.</Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Text fontSize="sm" color="fg.muted">
        GitHub Actions runs matching this submission&apos;s commit
        {submission.head_sha ? ` (${submission.head_sha.substring(0, 7)})` : ""}.
      </Text>
      <Box overflowX="auto">
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader w="80px">Status</Table.ColumnHeader>
              <Table.ColumnHeader>Workflow</Table.ColumnHeader>
              <Table.ColumnHeader w="140px">Conclusion</Table.ColumnHeader>
              <Table.ColumnHeader w="160px">Started</Table.ColumnHeader>
              <Table.ColumnHeader w="80px">Run</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {checks.map((check) => {
              const visual = statusVisual(check.status, check.conclusion);
              const url = runUrl(check);
              const startedAt = check.run_started_at ?? check.started_at ?? check.created_at;
              return (
                <Table.Row key={check.id}>
                  <Table.Cell>
                    <Icon as={visual.icon} color={`${visual.color}.fg`} aria-label={check.status ?? "unknown"} />
                  </Table.Cell>
                  <Table.Cell>
                    <VStack align="start" gap={0}>
                      <Text fontWeight="medium">{check.workflow_name ?? check.workflow_path ?? check.event_type}</Text>
                      {check.head_branch && (
                        <Text fontSize="xs" color="fg.muted">
                          {check.head_branch}
                          {check.run_number ? ` · #${check.run_number}` : ""}
                        </Text>
                      )}
                    </VStack>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge size="sm" colorPalette={visual.color}>
                      {check.conclusion ?? check.status ?? "unknown"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="sm" color="fg.muted">
                      {startedAt ? formatDistanceToNow(new Date(startedAt), { addSuffix: true }) : "—"}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    {url ? (
                      <Link href={url} target="_blank">
                        <HStack gap={1}>
                          <Icon as={FaGithub} />
                          View
                        </HStack>
                      </Link>
                    ) : (
                      <Text fontSize="sm" color="fg.muted">
                        —
                      </Text>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}
