"use client";
import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { confirmPrLink } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Assignment, SubmissionPrLink } from "@/utils/supabase/DatabaseTypes";
import { Alert, Badge, Box, Heading, HStack, Link, Spinner, Stack, Table, Text } from "@chakra-ui/react";
import { CrudFilter, useList } from "@refinedev/core";
import { useMemo, useState } from "react";

/**
 * Student-facing panel for pr-mode assignments: explains how to submit (open a
 * PR against the upstream/class repo) and shows the student's candidate PRs.
 *
 * The webhook records every PR that matches the assignment's identification
 * rule as a `submission_pr_links` row. When there is exactly one candidate (and
 * identification isn't `manual`) it is auto-confirmed and its pushes ingest as
 * submissions automatically. When there are several candidates — or
 * identification is `manual` — the student picks which PR is their submission
 * here; confirming ingests that PR's current state right away.
 */
export default function PrSubmissionPanel({
  assignment,
  assignmentGroupId,
  profileId,
  onConfirmed
}: {
  assignment: Assignment;
  assignmentGroupId?: number;
  profileId?: string;
  onConfirmed?: () => void;
}) {
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const filters = useMemo(() => {
    const f: CrudFilter[] = [{ field: "assignment_id", operator: "eq", value: assignment.id }];
    if (assignmentGroupId) {
      f.push({ field: "assignment_group_id", operator: "eq", value: assignmentGroupId });
    } else {
      f.push({ field: "profile_id", operator: "eq", value: profileId });
    }
    return f;
  }, [assignment.id, assignmentGroupId, profileId]);

  const {
    data: linksData,
    isLoading,
    refetch
  } = useList<SubmissionPrLink>({
    resource: "submission_pr_links",
    filters,
    pagination: { pageSize: 100 },
    sorters: [{ field: "created_at", order: "asc" }],
    queryOptions: { enabled: !!profileId || !!assignmentGroupId }
  });

  const links = linksData?.data ?? [];
  const hasConfirmed = links.some((l) => l.confirmed);

  const handleConfirm = async (linkId: number) => {
    setConfirmingId(linkId);
    try {
      const supabase = createClient();
      await confirmPrLink({ link_id: linkId }, supabase);
      toaster.success({ title: "Pull request confirmed", description: "This PR is now your submission." });
      await refetch();
      onConfirmed?.();
    } catch (e) {
      toaster.error({
        title: "Could not confirm pull request",
        description: e instanceof Error ? e.message : "Unknown error"
      });
    } finally {
      setConfirmingId(null);
    }
  };

  const baseBranch = assignment.upstream_base_branch || "main";

  return (
    <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
      <Toaster />
      <Heading size="md" mb={2}>
        Pull request submission
      </Heading>
      {assignment.upstream_repo ? (
        <Text fontSize="sm" color="fg.muted" mb={3}>
          Submit by opening a pull request against{" "}
          <Link href={`https://github.com/${assignment.upstream_repo}`} target="_blank" rel="noopener noreferrer">
            {assignment.upstream_repo}
          </Link>{" "}
          targeting the <code>{baseBranch}</code> branch
          {assignment.pr_identification === "branch_convention" && assignment.pr_branch_convention ? (
            <>
              {" "}
              from a head branch matching <code>{assignment.pr_branch_convention}</code>
            </>
          ) : null}
          . Each push to your PR is recorded as a new submission version automatically.
        </Text>
      ) : (
        <Alert.Root status="warning" mb={3}>
          <Alert.Title>Upstream repository not configured</Alert.Title>
          <Alert.Description>Your instructor has not set the upstream repository yet.</Alert.Description>
        </Alert.Root>
      )}

      {isLoading ? (
        <HStack color="fg.muted">
          <Spinner size="sm" /> <Text>Loading your pull requests…</Text>
        </HStack>
      ) : links.length === 0 ? (
        <Alert.Root status="info">
          <Alert.Title>No pull request detected yet</Alert.Title>
          <Alert.Description>
            {assignment.pr_identification === "manual"
              ? "Open your pull request, then ask course staff to link it, or it will appear here to confirm."
              : "Open your pull request as described above. It will appear here within a moment of being opened."}
          </Alert.Description>
        </Alert.Root>
      ) : (
        <Stack gap={3}>
          {!hasConfirmed && links.length > 1 && (
            <Alert.Root status="warning">
              <Alert.Title>Choose your submission pull request</Alert.Title>
              <Alert.Description>
                You have more than one candidate pull request. Confirm which one is your submission — only the confirmed
                PR is graded.
              </Alert.Description>
            </Alert.Root>
          )}
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Pull request</Table.ColumnHeader>
                <Table.ColumnHeader>Status</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Action</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {links.map((link) => (
                <Table.Row key={link.id}>
                  <Table.Cell>
                    <Link
                      href={`https://github.com/${link.pr_repo}/pull/${link.pr_number}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {link.pr_repo}#{link.pr_number}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    {link.confirmed ? (
                      <Badge colorPalette="green">Confirmed submission</Badge>
                    ) : (
                      <Badge colorPalette="gray">Candidate</Badge>
                    )}
                  </Table.Cell>
                  <Table.Cell textAlign="end">
                    {link.confirmed ? (
                      <Text fontSize="sm" color="fg.muted">
                        Active
                      </Text>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        loading={confirmingId === link.id}
                        onClick={() => handleConfirm(link.id)}
                      >
                        This is my submission
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Stack>
      )}
    </Box>
  );
}
