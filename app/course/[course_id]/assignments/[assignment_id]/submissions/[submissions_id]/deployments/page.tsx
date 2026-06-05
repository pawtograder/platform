"use client";

import Link from "@/components/ui/link";
import { useSubmission } from "@/hooks/useSubmission";
import { createClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, Flex, HStack, Icon, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { FaExternalLinkAlt } from "react-icons/fa";

type DeploymentRow = Pick<
  Database["public"]["Tables"]["github_deployments"]["Row"],
  "id" | "created_at" | "repository_name" | "sha" | "environment" | "state" | "target_url" | "creator_login"
>;

/** Map a deployment state to a Chakra colorPalette. */
function stateColor(state: string | null): string {
  switch (state) {
    case "success":
      return "green";
    case "failure":
    case "error":
      return "red";
    case "in_progress":
    case "queued":
    case "pending":
      return "blue";
    case "inactive":
      return "gray";
    default:
      return "gray";
  }
}

export default function SubmissionDeploymentsPage() {
  const submission = useSubmission();
  const supabase = useMemo(() => createClient(), []);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The deployment's (repository_name, sha) is matched to the submission's
  // (repository, head_sha | sha) — the same coalesce the RLS policy and
  // get_submission_checks use. A no-repo submission has no repository, so there
  // is nothing to match.
  const submissionRepository = submission.repository;
  const submissionSha = submission.head_sha ?? submission.sha;

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    if (!submissionRepository || !submissionSha) {
      setDeployments([]);
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error: queryError } = await supabase
        .from("github_deployments")
        .select("id, created_at, repository_name, sha, environment, state, target_url, creator_login")
        .eq("repository_name", submissionRepository)
        .eq("sha", submissionSha)
        .order("created_at", { ascending: false });
      if (!mounted) {
        return;
      }
      if (queryError) {
        setError(queryError.message);
        setDeployments([]);
      } else {
        setDeployments(data ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [supabase, submissionRepository, submissionSha]);

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
        <Text color="fg.error">Could not load deployments: {error}</Text>
      </Box>
    );
  }

  if (deployments.length === 0) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="fg.muted">No deployments for this submission yet.</Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Text fontSize="sm" color="fg.muted">
        GitHub deployments for this submission&apos;s commit
        {submissionSha ? ` (${submissionSha.substring(0, 7)})` : ""}.
      </Text>
      <Box overflowX="auto">
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader w="140px">Environment</Table.ColumnHeader>
              <Table.ColumnHeader w="120px">State</Table.ColumnHeader>
              <Table.ColumnHeader>URL</Table.ColumnHeader>
              <Table.ColumnHeader w="140px">Creator</Table.ColumnHeader>
              <Table.ColumnHeader w="160px">Created</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {deployments.map((deployment) => (
              <Table.Row key={deployment.id}>
                <Table.Cell>
                  <Text fontWeight="medium">{deployment.environment ?? "—"}</Text>
                </Table.Cell>
                <Table.Cell>
                  {deployment.state ? (
                    <Badge size="sm" colorPalette={stateColor(deployment.state)}>
                      {deployment.state}
                    </Badge>
                  ) : (
                    <Text fontSize="sm" color="fg.muted">
                      —
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {deployment.target_url ? (
                    <Link href={deployment.target_url} target="_blank">
                      <HStack gap={1} maxW="360px">
                        <Text overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                          {deployment.target_url}
                        </Text>
                        <Icon as={FaExternalLinkAlt} fontSize="xs" />
                      </HStack>
                    </Link>
                  ) : (
                    <Text fontSize="sm" color="fg.muted">
                      —
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm">{deployment.creator_login ?? "—"}</Text>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm" color="fg.muted">
                    {deployment.created_at
                      ? formatDistanceToNow(new Date(deployment.created_at), { addSuffix: true })
                      : "—"}
                  </Text>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}
