"use client";

import { toaster } from "@/components/ui/toaster";
import { useCourse, useCourseController } from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import { EdgeFunctionError, resendOrgInvitation } from "@/lib/edgeFunctions";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Badge,
  Box,
  Button,
  Code,
  Heading,
  HStack,
  Icon,
  Input,
  NativeSelect,
  NativeSelectField,
  Skeleton,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { CheckIcon, RefreshCw, GitPullRequest } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaExternalLinkAlt, FaTimes } from "react-icons/fa";
import { useList, useOne } from "@refinedev/core";
import { formatRelative } from "date-fns";
import { TZDate } from "@date-fns/tz";

type RepositoryRow = GetResult<
  Database["public"],
  Database["public"]["Tables"]["repositories"]["Row"],
  "repositories",
  Database["public"]["Tables"]["repositories"]["Relationships"],
  "*, assignment_groups(*), profiles(*), user_roles(*)"
>;

function ResendOrgInvitation({ userId, classId }: { userId?: string; classId?: number }) {
  const [isResending, setIsResending] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  if (!userId || !classId) {
    return null;
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={isResending}
      disabled={inviteSent}
      onClick={async () => {
        const supabase = createClient();
        try {
          setIsResending(true);
          await resendOrgInvitation({ course_id: classId, user_id: userId }, supabase);
          toaster.success({
            title: "Invitation resent",
            description: "The student should receive an email from GitHub shortly."
          });
          setIsResending(false);
          setInviteSent(true);
        } catch (error) {
          setIsResending(false);
          if (error instanceof EdgeFunctionError) {
            toaster.error({ title: "Error", description: error.message + " " + error.details });
          } else {
            console.error(error);
            toaster.error({ title: "Error", description: "Failed to resend invitation." });
          }
        }
      }}
    >
      Resend invitation
    </Button>
  );
}

function SyncStatusBadge({ row, latestTemplateSha }: { row: RepositoryRow; latestTemplateSha?: string | null }) {
  const syncData = row.sync_data as {
    pr_url?: string;
    pr_number?: number;
    pr_state?: string;
    last_sync_attempt?: string;
    last_sync_error?: string;
    merge_sha?: string;
  } | null;
  const desiredSha = row.desired_handout_sha?.substring(0, 7);
  const syncedSha = row.synced_handout_sha?.substring(0, 7);
  const latestSha = latestTemplateSha?.substring(0, 7);

  if (!desiredSha) {
    return <Badge colorPalette="gray">No Sync Requested</Badge>;
  }

  if (desiredSha === syncedSha) {
    // Check if synced SHA matches latest template SHA
    if (latestSha && syncedSha !== latestSha) {
      // Synced to desired SHA but template has moved forward
      return (
        <HStack gap={2}>
          <Badge colorPalette="red">Not Up-to-date</Badge>
          {syncData?.pr_number && syncData?.pr_url && (
            <Link href={syncData.pr_url} target="_blank">
              <HStack gap={1} fontSize="sm" color="blue.600">
                <Icon as={GitPullRequest} boxSize={3} />
                <Text>PR#{syncData.pr_number}</Text>
              </HStack>
            </Link>
          )}
        </HStack>
      );
    }

    // Synced and up-to-date with PR info if available
    if (syncData?.pr_number && syncData?.pr_url) {
      return (
        <HStack gap={2}>
          <Badge colorPalette="green">Synced</Badge>
          <Link href={syncData.pr_url} target="_blank">
            <HStack gap={1} fontSize="sm" color="blue.600">
              <Icon as={GitPullRequest} boxSize={3} />
              <Text>PR#{syncData.pr_number}</Text>
            </HStack>
          </Link>
        </HStack>
      );
    }
    return <Badge colorPalette="green">Synced</Badge>;
  }

  if (syncData?.pr_state === "open") {
    return (
      <HStack gap={2}>
        <Badge colorPalette="blue">PR Open</Badge>
        {syncData.pr_url && syncData.pr_number && (
          <Link href={syncData.pr_url} target="_blank">
            <HStack gap={1} fontSize="sm" color="blue.600">
              <Icon as={GitPullRequest} boxSize={3} />
              <Text>PR#{syncData.pr_number}</Text>
            </HStack>
          </Link>
        )}
      </HStack>
    );
  }

  if (syncData?.pr_state === "merged") {
    return (
      <HStack gap={2}>
        <Badge colorPalette="orange">Sync Finalizing</Badge>
        {syncData.pr_url && syncData.pr_number && (
          <Link href={syncData.pr_url} target="_blank">
            <HStack gap={1} fontSize="sm" color="blue.600">
              <Icon as={GitPullRequest} boxSize={3} />
              <Text>PR#{syncData.pr_number}</Text>
            </HStack>
          </Link>
        )}
      </HStack>
    );
  }

  if (syncData?.last_sync_error) {
    return (
      <VStack gap={2} alignItems="flex-start" width="full">
        <Badge colorPalette="red">Sync Error</Badge>
        <Box
          borderWidth="1px"
          borderColor="red.500"
          bg="red.50"
          _dark={{ bg: "red.950", borderColor: "red.800" }}
          px={3}
          py={2}
          borderRadius="md"
          width="full"
        >
          <Text fontSize="sm" color="red.700" _dark={{ color: "red.300" }} wordBreak="break-word">
            {syncData.last_sync_error}
          </Text>
        </Box>
      </VStack>
    );
  }

  return <Badge colorPalette="yellow">Sync in Progress</Badge>;
}

function SyncButton({
  repoId,
  tableController
}: {
  repoId: number;
  tableController: TableController<"repositories", typeof joinedSelect, number>;
}) {
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = async () => {
    const supabase = createClient();
    setIsSyncing(true);

    try {
      const { data, error } = await supabase.rpc("queue_repository_syncs", {
        p_repository_ids: [repoId]
      });

      if (error) throw error;

      const result = data as { queued_count: number; skipped_count: number; error_count: number };

      if (result.queued_count > 0) {
        toaster.success({
          title: "Sync Queued",
          description: "Repository sync has been queued. This page will automatically update."
        });
        // Invalidate the row to refetch its updated state
        await tableController.invalidate(repoId);
      } else if (result.skipped_count > 0) {
        toaster.info({
          title: "Already Up to Date",
          description: "Repository is already synced to the latest version."
        });
      } else {
        toaster.error({
          title: "Sync Failed",
          description: "Could not queue sync. Please try again."
        });
      }
    } catch (error) {
      console.error(error);
      toaster.error({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to queue sync"
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Button size="xs" variant="ghost" onClick={handleSync} loading={isSyncing} disabled={isSyncing}>
      <Icon as={RefreshCw} />
      Sync
    </Button>
  );
}

function HandoutCommitHistory({ assignmentId }: { assignmentId: number }) {
  const { time_zone } = useCourse();
  const { data: assignment } = useOne<Database["public"]["Tables"]["assignments"]["Row"]>({
    resource: "assignments",
    id: assignmentId
  });

  const { data: commits, isLoading } = useList<Database["public"]["Tables"]["assignment_handout_commits"]["Row"]>({
    resource: "assignment_handout_commits",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 10 }
  });

  if (!assignment?.data?.template_repo) {
    return null;
  }

  return (
    <VStack w="100%" alignItems="flex-start" gap={2} mb={4}>
      <Heading size="sm">Handout Commit History</Heading>
      <Text fontSize="sm" color="fg.muted">
        Template Repository: {assignment.data.template_repo}
        {assignment.data.latest_template_sha && (
          <>
            {" "}
            (Latest: <Code fontSize="xs">{assignment.data.latest_template_sha.substring(0, 7)}</Code>)
          </>
        )}
      </Text>
      <Box w="100%" bg="bg.muted" p={3} borderRadius="md">
        {isLoading && <Skeleton height="100px" />}
        {commits?.data && commits.data.length > 0 ? (
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>SHA</Table.ColumnHeader>
                <Table.ColumnHeader>Date</Table.ColumnHeader>
                <Table.ColumnHeader>Author</Table.ColumnHeader>
                <Table.ColumnHeader>Message</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {commits.data.map((commit) => {
                const commitDate = new TZDate(commit.created_at, time_zone || "America/New_York");
                return (
                  <Table.Row key={commit.id}>
                    <Table.Cell>
                      <Link
                        href={`https://github.com/${assignment.data.template_repo}/commit/${commit.sha}`}
                        target="_blank"
                      >
                        <Code fontSize="xs">{commit.sha.slice(0, 7)}</Code>
                      </Link>
                    </Table.Cell>
                    <Table.Cell fontSize="sm">
                      {formatRelative(commitDate, TZDate.tz(time_zone || "America/New_York"))}
                    </Table.Cell>
                    <Table.Cell fontSize="sm">{commit.author || "Unknown"}</Table.Cell>
                    <Table.Cell fontSize="sm">{commit.message}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        ) : (
          <Text fontSize="sm" color="fg.muted">
            No commits found for this handout.
          </Text>
        )}
      </Box>
    </VStack>
  );
}

const joinedSelect = "*, assignment_groups(*), profiles(*), user_roles(*)";

export default function RepositoriesPage() {
  const { assignment_id } = useParams();
  const courseController = useCourseController();

  // Get assignment data for latest template SHA
  const { data: assignment } = useOne<Database["public"]["Tables"]["assignments"]["Row"]>({
    resource: "assignments",
    id: Number(assignment_id)
  });

  const repositories: TableController<"repositories", typeof joinedSelect, number> = useMemo(() => {
    const client = createClient();
    const query = client
      .from("repositories")
      .select(joinedSelect)
      .eq("assignment_id", Number(assignment_id))
      .eq("user_roles.disabled", false);
    const controller = new TableController({
      query,
      client: client,
      table: "repositories",
      selectForSingleRow: joinedSelect,
      classRealTimeController: courseController.classRealTimeController,
      debounceInterval: 500 // Debounce rapid updates during bulk syncs
    });
    return controller;
  }, [assignment_id, courseController]);

  const [isBulkSyncing, setIsBulkSyncing] = useState(false);

  const columns = useMemo<ColumnDef<RepositoryRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
            aria-label="Select all repositories"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            aria-label={`Select repository ${row.original.repository}`}
          />
        ),
        enableSorting: false,
        enableColumnFilter: false
      },
      {
        id: "group_name",
        header: "Group",
        accessorFn: (row) => row.assignment_groups?.name ?? "—",
        cell: ({ row }) => <Text>{row.original.assignment_groups?.name ?? "—"}</Text>,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const name = (row.original as RepositoryRow).assignment_groups?.name ?? "—";
          return values.includes(name);
        }
      },
      {
        id: "profile_name",
        header: "Student",
        accessorFn: (row) => row.profiles?.name ?? "—",
        cell: ({ row }) => <Text>{row.original.profiles?.name ?? "—"}</Text>,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const name = (row.original as RepositoryRow).profiles?.name ?? "—";
          return values.some((val) => name.toLowerCase().includes(String(val).toLowerCase()));
        }
      },
      {
        id: "repository",
        header: "Repository",
        accessorKey: "repository",
        cell: ({ row }) => (
          <HStack gap={2}>
            <Link href={`https://github.com/${row.original.repository}`} target="_blank">
              {row.original.repository}
            </Link>
            <Icon as={FaExternalLinkAlt} color="gray.500" />
          </HStack>
        ),
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const repo = (row.original as RepositoryRow).repository;
          return values.some((val) => repo.toLowerCase().includes(String(val).toLowerCase()));
        }
      },
      {
        id: "is_github_ready",
        header: "GitHub Ready",
        accessorKey: "is_github_ready",
        cell: ({ row }) => (
          <HStack>
            {row.original.is_github_ready ? (
              <>
                <Icon as={CheckIcon} color="green.500" />
                <Text color="green.600">Ready</Text>
              </>
            ) : (
              <>
                <Icon as={FaTimes} color="red.500" />
                {row.original.user_roles?.github_org_confirmed ? (
                  <Text color="fg.muted">Not Ready, pending creation</Text>
                ) : (
                  <VStack gap={0} alignItems="flex-start">
                    <Text color="red.600">Not Ready, blocked: student has not joined course org</Text>
                    <ResendOrgInvitation
                      userId={row.original.user_roles?.user_id}
                      classId={row.original.user_roles?.class_id}
                    />
                  </VStack>
                )}
              </>
            )}
          </HStack>
        ),
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = (row.original as RepositoryRow).is_github_ready ? "Yes" : "No";
          return values.includes(val);
        }
      },
      {
        id: "synced_sha",
        header: "Synced SHA",
        accessorKey: "synced_handout_sha",
        cell: ({ row }) => {
          if (row.original.synced_handout_sha && assignment?.data?.template_repo) {
            const sha = row.original.synced_handout_sha;
            const commitUrl = `https://github.com/${assignment.data.template_repo}/commit/${sha}`;
            return (
              <Link href={commitUrl} target="_blank">
                <Code fontSize="xs" color="blue.600">
                  {sha.substring(0, 7)}
                </Code>
              </Link>
            );
          }
          if (row.original.synced_handout_sha) {
            // Fallback if template_repo not available
            return <Code fontSize="xs">{row.original.synced_handout_sha.substring(0, 7)}</Code>;
          }
          return (
            <Text fontSize="sm" color="fg.muted">
              —
            </Text>
          );
        },
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const sha = (row.original as RepositoryRow).synced_handout_sha;
          const displayValue = sha ? sha.substring(0, 7) : "(Not Synced)";
          return values.includes(displayValue);
        }
      },
      {
        id: "sync_status",
        header: "Sync Status",
        cell: ({ row }) => (
          <SyncStatusBadge row={row.original} latestTemplateSha={assignment?.data?.latest_template_sha} />
        ),
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const desiredSha = (row.original as RepositoryRow).desired_handout_sha;
          const syncedSha = (row.original as RepositoryRow).synced_handout_sha;
          const syncData = (row.original as RepositoryRow).sync_data as { pr_state?: string } | null;

          let status = "No Sync";
          if (!desiredSha) status = "No Sync";
          else if (desiredSha === syncedSha) status = "Synced";
          else if (syncData?.pr_state === "open") status = "PR Open";
          else status = "Sync in Progress";

          return values.includes(status);
        }
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => <SyncButton repoId={row.original.id} tableController={repositories} />
      }
    ],
    [repositories, assignment]
  );

  const {
    getHeaderGroups,
    getRowModel,
    getState,
    setPageIndex,
    getCanPreviousPage,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    data,
    getSelectedRowModel,
    toggleAllRowsSelected
  } = useTableControllerTable({
    columns,
    tableController: repositories,
    enableRowSelection: true,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      }
    }
  });

  const handleBulkSync = useCallback(async () => {
    const selectedRows = getSelectedRowModel().rows;
    const selectedIds = selectedRows.map((row) => row.original.id).filter((id): id is number => id !== undefined);

    if (selectedIds.length === 0) {
      toaster.error({
        title: "No Selection",
        description: "Please select repositories to sync."
      });
      return;
    }

    const supabase = createClient();
    setIsBulkSyncing(true);

    try {
      const { data: result, error } = await supabase.rpc("queue_repository_syncs", {
        p_repository_ids: selectedIds
      });

      if (error) throw error;

      const syncResult = result as { queued_count: number; skipped_count: number; error_count: number };

      toaster.success({
        title: "Sync Queued",
        description: `${syncResult.queued_count} repositories queued for sync. ${syncResult.skipped_count} skipped (already up to date).`
      });

      toggleAllRowsSelected(false);
      // Invalidate all synced rows to refetch their updated state
      await repositories.refetchByIds(selectedIds);
    } catch (error) {
      console.error(error);
      toaster.error({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to queue bulk sync"
      });
    } finally {
      setIsBulkSyncing(false);
    }
  }, [getSelectedRowModel, toggleAllRowsSelected, repositories]);

  const [pageCount, setPageCount] = useState(0);
  const nRows = getRowModel().rows.length;
  const pageSize = getState().pagination.pageSize;
  useEffect(() => {
    setPageCount(Math.ceil(nRows / pageSize) || 1);
  }, [nRows, pageSize]);

  const dataForOptions = useMemo(() => {
    const rows = (data as unknown as RepositoryRow[]) ?? [];
    const groupSet = new Set<string>();
    const studentSet = new Set<string>();
    const repoSet = new Set<string>();
    const syncedShaSet = new Set<string>();
    for (const r of rows) {
      groupSet.add(r.assignment_groups?.name ?? "—");
      studentSet.add(r.profiles?.name ?? "—");
      repoSet.add(r.repository);
      if (r.synced_handout_sha) {
        syncedShaSet.add(r.synced_handout_sha.substring(0, 7));
      } else {
        syncedShaSet.add("(Not Synced)");
      }
    }
    return {
      groups: Array.from(groupSet.values()),
      students: Array.from(studentSet.values()),
      repos: Array.from(repoSet.values()),
      syncedShas: Array.from(syncedShaSet.values()).sort()
    };
  }, [data]);

  const selectedCount = getSelectedRowModel().rows.length;

  return (
    <VStack w="100%">
      <VStack paddingBottom="55px" w="100%">
        <Box>
          <Heading size="sm">Repository Status</Heading>
          <Text fontSize="sm" color="fg.muted">
            Student repositories are generated from the template repository at the time of assignment release (usually
            created at a rate of about 50 per-minute, as rate-limited by GitHub). The &quot;GitHub Ready&quot; column
            shows the status of the student repository, confirming that the repository has been correctly provisioned or
            show a loading/error state. Student repositories are created as a snapshot of the template repository at the
            time of release, showing students ONLY a single &quot;Initial Commit&quot; of the template repository. If
            you need to make changes to the template repository after release, you can use the &quot;Sync&quot; feature,
            which will create a pull request to the student repository, auto-merging if there are no conflicts, which
            will create a new submission. This procedure is also heavily rate-limited by GitHub, working at a rate of no
            more than 50 pull requests per-minute per-class.
          </Text>
        </Box>
        <HandoutCommitHistory assignmentId={Number(assignment_id)} />

        {selectedCount > 0 && (
          <HStack w="100%" justifyContent="space-between" p={4} bg="bg.subtle" borderRadius="md">
            <Text fontWeight="medium">{selectedCount} repository(ies) selected</Text>
            <Button colorPalette="blue" onClick={handleBulkSync} loading={isBulkSyncing} disabled={isBulkSyncing}>
              <Icon as={RefreshCw} />
              Sync Selected
            </Button>
          </HStack>
        )}
        <Box overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto" w="100%">
          <Heading size="sm">Repository Status</Heading>
          <Table.Root minW="0" w="100%">
            <Table.Header>
              {getHeaderGroups().map((headerGroup) => (
                <Table.Row key={headerGroup.id} bg="bg.subtle">
                  {headerGroup.headers.map((header) => (
                    <Table.ColumnHeader key={header.id}>
                      {header.isPlaceholder ? null : (
                        <>
                          <Text onClick={header.column.getToggleSortingHandler()}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {{
                              asc: " 🔼",
                              desc: " 🔽"
                            }[header.column.getIsSorted() as string] ?? " 🔄"}
                          </Text>
                          {header.id === "group_name" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.groups.map((name) => ({ label: name, value: name }))}
                              placeholder="Filter by group..."
                            />
                          )}
                          {header.id === "profile_name" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.students.map((name) => ({ label: name, value: name }))}
                              placeholder="Filter by student..."
                            />
                          )}
                          {header.id === "repository" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.repos.map((repo) => ({ label: repo, value: repo }))}
                              placeholder="Filter by repository..."
                            />
                          )}
                          {header.id === "is_github_ready" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                { label: "Yes", value: "Yes" },
                                { label: "No", value: "No" }
                              ]}
                              placeholder="Filter by readiness..."
                            />
                          )}
                          {header.id === "synced_sha" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.syncedShas.map((sha) => ({ label: sha, value: sha }))}
                              placeholder="Filter by synced SHA..."
                            />
                          )}
                          {header.id === "sync_status" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                { label: "Synced", value: "Synced" },
                                { label: "Sync in Progress", value: "Sync in Progress" },
                                { label: "PR Open", value: "PR Open" },
                                { label: "No Sync", value: "No Sync" }
                              ]}
                              placeholder="Filter by sync status..."
                            />
                          )}
                        </>
                      )}
                    </Table.ColumnHeader>
                  ))}
                </Table.Row>
              ))}
            </Table.Header>
            <Table.Body>
              {getRowModel().rows.map((row) => (
                <Table.Row key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>

        <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
          <HStack gap={2}>
            <Button size="sm" onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
              {"<<"}
            </Button>
            <Button size="sm" onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
              {"<"}
            </Button>
            <Button size="sm" onClick={() => nextPage()} disabled={!getCanNextPage()}>
              {">"}
            </Button>
            <Button size="sm" onClick={() => setPageIndex(pageCount - 1)} disabled={!getCanNextPage()}>
              {">>"}
            </Button>
          </HStack>

          <HStack gap={2} alignItems="center">
            <Text whiteSpace="nowrap">
              Page{" "}
              <strong>
                {getState().pagination.pageIndex + 1} of {pageCount}
              </strong>
            </Text>
            <Text whiteSpace="nowrap">| Go to page:</Text>
            <Input
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              min={1}
              max={pageCount}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                const newPageIndex = Math.max(0, Math.min(page, pageCount - 1));
                setPageIndex(newPageIndex);
              }}
              width="60px"
              textAlign="center"
            />
          </HStack>

          <NativeSelect.Root title="Select page size" aria-label="Select page size" width="120px">
            <NativeSelectField
              title="Select page size"
              aria-label="Select page size"
              value={getState().pagination.pageSize}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                setPageSize(Number(e.target.value));
              }}
            >
              {[25, 50, 100, 200, 500, 1000].map((pageSizeOption) => (
                <option key={pageSizeOption} value={pageSizeOption}>
                  Show {pageSizeOption}
                </option>
              ))}
            </NativeSelectField>
          </NativeSelect.Root>
        </HStack>
      </VStack>
    </VStack>
  );
}
