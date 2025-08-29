"use client";

import { Box, Heading, Text, HStack, Button, Spinner, Input } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import PersonName from "@/components/ui/person-name";
import { Table } from "@chakra-ui/react";
import {
  flexRender,
  type ColumnDef,
  type CellContext,
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  type ColumnFiltersState,
  type SortingState,
  type PaginationState
} from "@tanstack/react-table";
import { Select, CreatableSelect } from "chakra-react-select";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient } from "@/utils/supabase/client";

export default function WorkflowRunsPage() {
  return (
    <Box>
      <Heading as="h1" size="lg" mb={4}>
        Workflow Runs
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={6}>
        History of recent GitHub Actions workflow executions for student submissions. This page shows detailed timing
        information and execution status. Data calculated every 5 minutes, only showing the most recent 1000 runs.
      </Text>
      <WorkflowRunTable />
    </Box>
  );
}

type WorkflowEventSummaryRow = Database["public"]["Views"]["workflow_events_summary"]["Row"];
function WorkflowRunTable() {
  const { course_id } = useParams();
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: "requested_at",
      desc: true
    }
  ]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 25
  });

  const [rows, setRows] = useState<WorkflowEventSummaryRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const classId = Number(course_id);
        if (!classId || Number.isNaN(classId)) {
          setRows([]);
          return;
        }
        const { data, error } = await supabase.rpc("get_workflow_events_summary_for_class", {
          p_class_id: classId
        });
        if (!mounted) return;
        if (error) {
          setErr(error.message);
          setRows([]);
        } else {
          setRows((data || []) as unknown as WorkflowEventSummaryRow[]);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [course_id]);

  const columns = useMemo<ColumnDef<WorkflowEventSummaryRow>[]>(
    () => [
      {
        id: "workflow_run_id",
        accessorKey: "workflow_run_id",
        header: "Run ID",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => (
          <Text fontFamily="mono" fontSize="sm">
            #{getValue() as string}
          </Text>
        ),
        filterFn: (row, id, filterValue) => {
          const runId = String(row.original.workflow_run_id);
          const filterString = String(filterValue).toLowerCase();
          return runId.toLowerCase().includes(filterString);
        }
      },
      {
        id: "run_attempt",
        accessorKey: "run_attempt",
        header: "Attempt",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => (
          <Text fontSize="sm">{(getValue() as number) || "-"}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          const attempt = String(row.original.run_attempt || "");
          const filterString = String(filterValue).toLowerCase();
          return attempt.toLowerCase().includes(filterString);
        }
      },
      {
        id: "profile_id",
        accessorKey: "profile_id",
        header: "Student",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => {
          const profileId = getValue() as string;
          if (!profileId) return <Text fontSize="sm">-</Text>;
          return <PersonName uid={profileId} size="sm" showAvatar={false} />;
        },
        filterFn: (row, id, filterValue) => {
          const profileId = String(row.original.profile_id || "");
          const filterString = String(filterValue).toLowerCase();
          return profileId.toLowerCase().includes(filterString);
        }
      },
      {
        id: "actor_login",
        accessorKey: "actor_login",
        header: "Triggered By",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => (
          <Text fontSize="sm">{(getValue() as string) || "Unknown"}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          const actor = String(row.original.actor_login || "unknown");
          const filterString = String(filterValue).toLowerCase();
          return actor.toLowerCase().includes(filterString);
        }
      },
      {
        id: "head_branch",
        accessorKey: "head_branch",
        header: "Branch",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => (
          <Box as="span" px={2} py={1} bg="bg.subtle" borderRadius="sm" fontSize="xs" fontFamily="mono">
            {(getValue() as string) || "Unknown"}
          </Box>
        ),
        filterFn: (row, id, filterValue) => {
          const branch = String(row.original.head_branch || "unknown");
          const filterString = String(filterValue).toLowerCase();
          return branch.toLowerCase().includes(filterString);
        }
      },
      {
        id: "head_sha",
        accessorKey: "head_sha",
        header: "Commit",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => {
          const sha = getValue() as string;
          if (!sha) return <Text fontSize="sm">-</Text>;
          return (
            <Text fontFamily="mono" fontSize="xs" color="fg.muted">
              {sha.substring(0, 7)}
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          const sha = String(row.original.head_sha || "");
          const filterString = String(filterValue).toLowerCase();
          return sha.toLowerCase().includes(filterString);
        }
      },
      {
        id: "status",
        header: "Status",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowEventSummaryRow, unknown>) => {
          const { requested_at, in_progress_at, completed_at } = row.original;

          if (completed_at) {
            return (
              <Box
                as="span"
                px={2}
                py={1}
                bg="green.50"
                color="green.700"
                borderRadius="sm"
                fontSize="xs"
                fontWeight="medium"
              >
                Completed
              </Box>
            );
          } else if (in_progress_at) {
            return (
              <Box
                as="span"
                px={2}
                py={1}
                bg="blue.50"
                color="blue.700"
                borderRadius="sm"
                fontSize="xs"
                fontWeight="medium"
              >
                In Progress
              </Box>
            );
          } else if (requested_at) {
            return (
              <Box
                as="span"
                px={2}
                py={1}
                bg="yellow.50"
                color="yellow.700"
                borderRadius="sm"
                fontSize="xs"
                fontWeight="medium"
              >
                Requested
              </Box>
            );
          } else {
            return (
              <Box
                as="span"
                px={2}
                py={1}
                bg="gray.50"
                color="gray.700"
                borderRadius="sm"
                fontSize="xs"
                fontWeight="medium"
              >
                Unknown
              </Box>
            );
          }
        },
        filterFn: (row, id, filterValue) => {
          const { requested_at, in_progress_at, completed_at } = row.original;
          let status = "unknown";
          if (completed_at) status = "completed";
          else if (in_progress_at) status = "in progress";
          else if (requested_at) status = "requested";

          const filterString = String(filterValue).toLowerCase();
          return status.includes(filterString);
        }
      },
      {
        id: "requested_at",
        accessorKey: "requested_at",
        header: "Timeline",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowEventSummaryRow, unknown>) => {
          const { requested_at, in_progress_at, completed_at } = row.original;

          return (
            <Box fontSize="xs" color="fg.muted">
              {requested_at && (
                <Text>Requested: {formatDistanceToNow(new Date(requested_at), { addSuffix: true })}</Text>
              )}
              {in_progress_at && (
                <Text>Started: {formatDistanceToNow(new Date(in_progress_at), { addSuffix: true })}</Text>
              )}
              {completed_at && (
                <Text>Completed: {formatDistanceToNow(new Date(completed_at), { addSuffix: true })}</Text>
              )}
            </Box>
          );
        },
        filterFn: (row, id, filterValue) => {
          const { requested_at, in_progress_at, completed_at } = row.original;
          const filterString = String(filterValue).toLowerCase();

          let timelineText = "";
          if (requested_at)
            timelineText += formatDistanceToNow(new Date(requested_at), { addSuffix: true }).toLowerCase();
          if (in_progress_at)
            timelineText += " " + formatDistanceToNow(new Date(in_progress_at), { addSuffix: true }).toLowerCase();
          if (completed_at)
            timelineText += " " + formatDistanceToNow(new Date(completed_at), { addSuffix: true }).toLowerCase();

          return timelineText.includes(filterString);
        }
      },
      {
        id: "run_number",
        accessorKey: "run_number",
        header: "Run #",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => (
          <Text fontSize="sm">{(getValue() as number) || "-"}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          const runNumber = String(row.original.run_number || "");
          const filterString = String(filterValue).toLowerCase();
          return runNumber.toLowerCase().includes(filterString);
        }
      },
      {
        id: "queue_time_seconds",
        accessorKey: "queue_time_seconds",
        header: "Queue Time",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => {
          const seconds = getValue() as number;
          if (!seconds) return <Text fontSize="sm">-</Text>;

          if (seconds < 60) {
            return (
              <Text fontSize="sm" color="green.600">
                {seconds}s
              </Text>
            );
          } else if (seconds < 3600) {
            const minutes = Math.round(seconds / 60);
            return (
              <Text fontSize="sm" color="orange.600">
                {minutes}m
              </Text>
            );
          } else {
            const hours = Math.round(seconds / 3600);
            return (
              <Text fontSize="sm" color="red.600">
                {hours}h
              </Text>
            );
          }
        },
        filterFn: (row, id, filterValue) => {
          const seconds = row.original.queue_time_seconds;
          const filterString = String(filterValue).toLowerCase();

          if (!seconds) return filterString === "";

          let timeText = "";
          if (seconds < 60) {
            timeText = `${seconds}s`;
          } else if (seconds < 3600) {
            const minutes = Math.round(seconds / 60);
            timeText = `${minutes}m`;
          } else {
            const hours = Math.round(seconds / 3600);
            timeText = `${hours}h`;
          }

          return timeText.toLowerCase().includes(filterString);
        }
      },
      {
        id: "run_time_seconds",
        accessorKey: "run_time_seconds",
        header: "Run Time",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowEventSummaryRow, unknown>) => {
          const seconds = getValue() as number;
          if (!seconds) return <Text fontSize="sm">-</Text>;

          if (seconds < 60) {
            return (
              <Text fontSize="sm" color="green.600">
                {seconds}s
              </Text>
            );
          } else if (seconds < 3600) {
            const minutes = Math.round(seconds / 60);
            return (
              <Text fontSize="sm" color="orange.600">
                {minutes}m
              </Text>
            );
          } else {
            const hours = Math.round(seconds / 3600);
            return (
              <Text fontSize="sm" color="red.600">
                {hours}h
              </Text>
            );
          }
        },
        filterFn: (row, id, filterValue) => {
          const seconds = row.original.run_time_seconds;
          const filterString = String(filterValue).toLowerCase();

          if (!seconds) return filterString === "";

          let timeText = "";
          if (seconds < 60) {
            timeText = `${seconds}s`;
          } else if (seconds < 3600) {
            const minutes = Math.round(seconds / 60);
            timeText = `${minutes}m`;
          } else {
            const hours = Math.round(seconds / 3600);
            timeText = `${hours}h`;
          }

          return timeText.toLowerCase().includes(filterString);
        }
      }
    ],
    []
  );

  const allData = rows || [];

  const table = useReactTable({
    data: allData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    state: {
      columnFilters,
      sorting,
      pagination
    }
  });

  if (loading) {
    return (
      <Box>
        <Box display="flex" justifyContent="center" alignItems="center" py={4}>
          <Spinner size="sm" />
        </Box>
      </Box>
    );
  }

  if (err) {
    return (
      <Box>
        <Box p={4} bg="red.50" border="1px solid" borderColor="red.200" borderRadius="md">
          <Text color="red.600">Failed to load workflow runs: {err}</Text>
        </Box>
      </Box>
    );
  }

  const workflowRuns = table.getRowModel().rows.map((row) => row.original);
  const pageCount = table.getPageCount();

  // Extract unique values for filter options
  const uniqueRunIds = [...new Set(allData.map((run) => String(run.workflow_run_id)).filter(Boolean))].map((id) => ({
    label: `#${id}`,
    value: id
  }));

  const uniqueAttempts = [...new Set(allData.map((run) => String(run.run_attempt)).filter(Boolean))].map((attempt) => ({
    label: attempt,
    value: attempt
  }));

  const uniqueActors = [...new Set(allData.map((run) => run.actor_login || "unknown").filter(Boolean))].map(
    (actor) => ({
      label: actor,
      value: actor
    })
  );

  const uniqueBranches = [...new Set(allData.map((run) => run.head_branch || "unknown").filter(Boolean))].map(
    (branch) => ({
      label: branch,
      value: branch
    })
  );

  const uniqueCommits = [...new Set(allData.map((run) => run.head_sha).filter(Boolean))].map((sha) => ({
    label: sha?.substring(0, 7) || "unknown",
    value: sha
  }));

  const uniqueRunNumbers = [...new Set(allData.map((run) => String(run.run_number)).filter(Boolean))].map((num) => ({
    label: num,
    value: num
  }));

  return (
    <Box>
      {workflowRuns.length === 0 ? (
        <Box p={6} borderRadius="md" textAlign="center">
          <Text fontSize="lg" fontWeight="medium">
            🚀 No workflow runs found!
          </Text>
          <Text fontSize="sm" mt={2}>
            No workflow executions have been recorded for this course yet.
          </Text>
        </Box>
      ) : (
        <>
          {/* Clear Filters Button */}
          <HStack justify="space-between" mb={4}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Clear all column filters
                table.resetColumnFilters();
              }}
            >
              Clear All Filters
            </Button>
            <Text fontSize="sm" color="fg.muted">
              Showing {workflowRuns.length} of {allData.length} runs
            </Text>
          </HStack>

          <Table.Root>
            <Table.Header>
              {table.getHeaderGroups().map((headerGroup) => (
                <Table.Row bg="bg.subtle" key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <Table.ColumnHeader key={header.id}>
                        {header.isPlaceholder ? null : (
                          <>
                            <Text
                              onClick={header.column.getToggleSortingHandler()}
                              cursor={header.column.getCanSort() ? "pointer" : "default"}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: " 🔼",
                                desc: " 🔽"
                              }[header.column.getIsSorted() as string] ?? null}
                            </Text>
                            {header.column.getCanFilter() && (
                              <>
                                {header.id === "workflow_run_id" && (
                                  <CreatableSelect
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={uniqueRunIds}
                                    placeholder="Filter by run ID..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "run_attempt" && (
                                  <CreatableSelect
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={uniqueAttempts}
                                    placeholder="Filter by attempt..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "profile_id" && (
                                  <Input
                                    id={header.id}
                                    value={(header.column.getFilterValue() as string) ?? ""}
                                    onChange={(e) => {
                                      header.column.setFilterValue(e.target.value);
                                    }}
                                    placeholder="Filter by student ID..."
                                    size="sm"
                                    mt={2}
                                  />
                                )}
                                {header.id === "actor_login" && (
                                  <CreatableSelect
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={uniqueActors}
                                    placeholder="Filter by actor..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "head_branch" && (
                                  <CreatableSelect
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={uniqueBranches}
                                    placeholder="Filter by branch..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "head_sha" && (
                                  <CreatableSelect
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={uniqueCommits}
                                    placeholder="Filter by commit..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "status" && (
                                  <Select
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={[
                                      { label: "Completed", value: "completed" },
                                      { label: "In Progress", value: "in progress" },
                                      { label: "Requested", value: "requested" },
                                      { label: "Unknown", value: "unknown" }
                                    ]}
                                    placeholder="Filter by status..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "requested_at" && (
                                  <Select
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={[
                                      { label: "today", value: "today" },
                                      { label: "yesterday", value: "yesterday" },
                                      { label: "ago", value: "ago" },
                                      { label: "hour", value: "hour" },
                                      { label: "minute", value: "minute" },
                                      { label: "day", value: "day" },
                                      { label: "week", value: "week" },
                                      { label: "month", value: "month" }
                                    ]}
                                    placeholder="Filter by timeline..."
                                    size="sm"
                                  />
                                )}
                                {header.id === "run_number" && (
                                  <CreatableSelect
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={uniqueRunNumbers}
                                    placeholder="Filter by run #..."
                                    size="sm"
                                  />
                                )}
                                {(header.id === "queue_time_seconds" || header.id === "run_time_seconds") && (
                                  <Select
                                    isMulti={false}
                                    id={header.id}
                                    isClearable
                                    isSearchable
                                    onChange={(e) => {
                                      header.column.setFilterValue(e?.value || "");
                                    }}
                                    options={[
                                      { label: "< 1 minute", value: "s" },
                                      { label: "< 1 hour", value: "m" },
                                      { label: "> 1 hour", value: "h" }
                                    ]}
                                    placeholder="Filter by time..."
                                    size="sm"
                                  />
                                )}
                              </>
                            )}
                          </>
                        )}
                      </Table.ColumnHeader>
                    );
                  })}
                </Table.Row>
              ))}
            </Table.Header>
            <Table.Body>
              {table.getRowModel().rows.map((row) => (
                <Table.Row key={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    return (
                      <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                    );
                  })}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>

          {/* Pagination Controls */}
          <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
            <HStack gap={2}>
              <Button size="sm" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
                {"<<"}
              </Button>
              <Button size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
                {"<"}
              </Button>
              <Button size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
                {">"}
              </Button>
              <Button size="sm" onClick={() => table.setPageIndex(pageCount - 1)} disabled={!table.getCanNextPage()}>
                {">>"}
              </Button>
            </HStack>

            <HStack gap={2} alignItems="center">
              <Text whiteSpace="nowrap">
                Page{" "}
                <strong>
                  {table.getState().pagination.pageIndex + 1} of {pageCount}
                </strong>
              </Text>
              <Text whiteSpace="nowrap">| Go to page:</Text>
              <Input
                type="number"
                defaultValue={table.getState().pagination.pageIndex + 1}
                min={1}
                max={pageCount}
                onChange={(e) => {
                  const page = e.target.value ? Number(e.target.value) - 1 : 0;
                  const newPageIndex = Math.max(0, Math.min(page, pageCount - 1));
                  table.setPageIndex(newPageIndex);
                }}
                width="60px"
                textAlign="center"
                size="sm"
              />
            </HStack>

            <HStack gap={2}>
              <Text fontSize="sm">Page size:</Text>
              <select
                value={table.getState().pagination.pageSize}
                onChange={(e) => {
                  table.setPageSize(Number(e.target.value));
                }}
                style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #ccc" }}
              >
                {[10, 25, 50, 100].map((pageSizeOption) => (
                  <option key={pageSizeOption} value={pageSizeOption}>
                    Show {pageSizeOption}
                  </option>
                ))}
              </select>
            </HStack>
          </HStack>
        </>
      )}
    </Box>
  );
}
