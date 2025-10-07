"use client";

import { Box, Heading, Text, Icon, IconButton, HStack, Link } from "@chakra-ui/react";
import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import PersonName from "@/components/ui/person-name";
import { Table } from "@chakra-ui/react";
import { flexRender, ColumnDef, CellContext } from "@tanstack/react-table";
import { CreatableSelect } from "chakra-react-select";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient } from "@/utils/supabase/client";
import TableController from "@/lib/TableController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import { useCourseController } from "@/hooks/useCourseController";
import { FaSort, FaSortDown, FaSortUp } from "react-icons/fa";
import { LuRefreshCw } from "react-icons/lu";
import { LuExternalLink } from "react-icons/lu";

export default function WorkflowRunsPage() {
  return (
    <Box>
      <Heading as="h1" size="lg" mb={4}>
        Workflow Runs
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={6}>
        History of recent GitHub Actions workflow executions for student submissions. This page shows detailed timing
        information and execution status. Data updated in real-time (click refresh icon to update), showing the most
        recent 1000 runs.
      </Text>
      <WorkflowRunTable />
    </Box>
  );
}

type WorkflowRunRow = Database["public"]["Tables"]["workflow_runs"]["Row"] & {
  repository_name?: string | null;
};

interface SelectOption {
  label: string;
  value: string;
}

function WorkflowRunTable() {
  const { course_id } = useParams();

  const columns = useMemo<ColumnDef<WorkflowRunRow>[]>(
    () => [
      {
        id: "workflow_run_id",
        accessorKey: "workflow_run_id",
        header: "Run ID",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue, row }: CellContext<WorkflowRunRow, unknown>) => {
          const runId = getValue() as number;
          const repoName = row.original.repository_name;
          if (!repoName) {
            return (
              <Text fontFamily="mono" fontSize="sm">
                #{runId}
              </Text>
            );
          }
          return (
            <Link
              href={`https://github.com/${repoName}/actions/runs/${runId}`}
              target="_blank"
              rel="noopener noreferrer"
              color="blue.600"
              _hover={{ color: "blue.700", textDecoration: "underline" }}
            >
              <HStack gap={1}>
                <Text fontFamily="mono" fontSize="sm">
                  #{runId}
                </Text>
                <Icon boxSize={3}>
                  <LuExternalLink />
                </Icon>
              </HStack>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const runId = String(row.original.workflow_run_id);
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => runId.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "run_attempt",
        accessorKey: "run_attempt",
        header: "Attempt",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => (
          <Text fontSize="sm">{(getValue() as number) || "-"}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const attempt = String(row.original.run_attempt || "");
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => attempt.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "profile_id",
        accessorKey: "profile_id",
        header: "Student",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => {
          const profileId = getValue() as string;
          if (!profileId) return <Text fontSize="sm">-</Text>;
          return <PersonName uid={profileId} size="sm" showAvatar={false} />;
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const profileId = String(row.original.profile_id || "");
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => profileId.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "actor_login",
        accessorKey: "actor_login",
        header: "Triggered By",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => (
          <Text fontSize="sm">{(getValue() as string) || "Unknown"}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const actor = String(row.original.actor_login || "unknown");
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => actor.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "head_branch",
        accessorKey: "head_branch",
        header: "Branch",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => (
          <Box as="span" px={2} py={1} bg="bg.subtle" borderRadius="sm" fontSize="xs" fontFamily="mono">
            {(getValue() as string) || "Unknown"}
          </Box>
        ),
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const branch = String(row.original.head_branch || "unknown");
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => branch.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "head_sha",
        accessorKey: "head_sha",
        header: "Commit",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue, row }: CellContext<WorkflowRunRow, unknown>) => {
          const sha = getValue() as string;
          const repoName = row.original.repository_name;
          if (!sha) return <Text fontSize="sm">-</Text>;
          if (!repoName) {
            return (
              <Text fontFamily="mono" fontSize="xs" color="fg.muted">
                {sha.substring(0, 7)}
              </Text>
            );
          }
          return (
            <Link
              href={`https://github.com/${repoName}/commit/${sha}`}
              target="_blank"
              rel="noopener noreferrer"
              color="blue.600"
              _hover={{ color: "blue.700", textDecoration: "underline" }}
            >
              <HStack gap={1}>
                <Text fontFamily="mono" fontSize="xs">
                  {sha.substring(0, 7)}
                </Text>
                <Icon boxSize={3}>
                  <LuExternalLink />
                </Icon>
              </HStack>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const sha = String(row.original.head_sha || "");
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => sha.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "status",
        header: "Status",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowRunRow, unknown>) => {
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
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const { requested_at, in_progress_at, completed_at } = row.original;
          let status = "unknown";
          if (completed_at) status = "completed";
          else if (in_progress_at) status = "in progress";
          else if (requested_at) status = "requested";

          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => status.includes(filter.toLowerCase()));
        }
      },
      {
        id: "requested_at",
        accessorKey: "requested_at",
        header: "Timeline",
        enableColumnFilter: false,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowRunRow, unknown>) => {
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
        }
      },
      {
        id: "run_number",
        accessorKey: "run_number",
        header: "Run #",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => (
          <Text fontSize="sm">{(getValue() as number) || "-"}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const runNumber = String(row.original.run_number || "");
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => runNumber.toLowerCase().includes(filter.toLowerCase()));
        }
      },
      {
        id: "queue_time_seconds",
        accessorKey: "queue_time_seconds",
        header: "Queue Time",
        enableColumnFilter: false,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => {
          const seconds = getValue() as number;
          if (!seconds) return <Text fontSize="sm">-</Text>;

          if (seconds < 60) {
            return (
              <Text fontSize="sm" color="green.600">
                {Math.round(seconds)}s
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
        }
      },
      {
        id: "run_time_seconds",
        accessorKey: "run_time_seconds",
        header: "Run Time",
        enableColumnFilter: false,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => {
          const seconds = getValue() as number;
          if (!seconds) return <Text fontSize="sm">-</Text>;

          if (seconds < 60) {
            return (
              <Text fontSize="sm" color="green.600">
                {Math.round(seconds)}s
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
        }
      }
    ],
    []
  );

  const supabase = useMemo(() => createClient(), []);
  const { classRealTimeController } = useCourseController();

  const tableController = useMemo(() => {
    const query = supabase
      .from("workflow_runs")
      .select("*")
      .eq("class_id", Number(course_id))
      .order("requested_at", { ascending: false })
      .limit(1000);

    return new TableController({
      query: query,
      client: supabase,
      table: "workflow_runs",
      classRealTimeController
    });
  }, [supabase, course_id, classRealTimeController]);

  const {
    getHeaderGroups,
    getRowModel,
    getCoreRowModel,
    data,
    tableController: controller
  } = useTableControllerTable({
    columns,
    tableController,
    initialState: {
      sorting: [{ id: "requested_at", desc: true }],
      pagination: {
        pageIndex: 0,
        pageSize: 25
      }
    }
  });

  // Compute unique values for filter options from ALL rows (before filtering)
  const columnUniqueValues = useMemo(() => {
    const rows = getCoreRowModel().rows;
    const uniqueValuesMap: Record<string, SelectOption[]> = {};

    columns.forEach((column) => {
      if (!column.enableColumnFilter || !column.id) return;

      if (column.id === "status") {
        // Status is computed from timestamps
        const statuses = new Set<string>();
        rows.forEach((row) => {
          const { requested_at, in_progress_at, completed_at } = row.original;
          if (completed_at) statuses.add("completed");
          else if (in_progress_at) statuses.add("in progress");
          else if (requested_at) statuses.add("requested");
          else statuses.add("unknown");
        });
        uniqueValuesMap[column.id] = Array.from(statuses).map((status) => ({
          label: status.charAt(0).toUpperCase() + status.slice(1),
          value: status
        }));
        return;
      }

      const uniqueValues = new Set<string>();
      rows.forEach((row) => {
        const value = row.getValue(column.id as string);
        if (value !== null && value !== undefined) {
          uniqueValues.add(String(value));
        }
      });

      uniqueValuesMap[column.id] = Array.from(uniqueValues)
        .sort()
        .map((value) => ({
          label: column.id === "workflow_run_id" ? `#${value}` : value,
          value: value
        }));
    });

    return uniqueValuesMap;
  }, [columns, getCoreRowModel]);

  const workflowRuns = getRowModel().rows;

  return (
    <Box>
      {/* Refresh button */}
      <HStack justify="flex-end" mb={4}>
        <IconButton
          aria-label="Refresh workflow runs"
          size="sm"
          variant="outline"
          onClick={async () => {
            await controller?.refetchAll();
          }}
        >
          <LuRefreshCw />
        </IconButton>
      </HStack>

      {workflowRuns.length === 0 && data.length === 0 ? (
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
          <Table.Root>
            <Table.Header>
              {getHeaderGroups().map((headerGroup) => (
                <Table.Row bg="bg.subtle" key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const canFilter = header.column.columnDef.enableColumnFilter;
                    const options = columnUniqueValues[header.id] || [];

                    return (
                      <Table.ColumnHeader key={header.id}>
                        {header.isPlaceholder ? null : (
                          <>
                            <Text onClick={header.column.getToggleSortingHandler()} cursor="pointer">
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: (
                                  <Icon size="md">
                                    <FaSortUp />
                                  </Icon>
                                ),
                                desc: (
                                  <Icon size="md">
                                    <FaSortDown />
                                  </Icon>
                                )
                              }[header.column.getIsSorted() as string] ?? (
                                <Icon size="md">
                                  <FaSort />
                                </Icon>
                              )}
                            </Text>
                            {canFilter && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={options}
                                placeholder={`Filter ${header.column.columnDef.header}...`}
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({
                                        label: v,
                                        value: v
                                      }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(selected ? selected.map((option) => option.value) : []);
                                }}
                                chakraStyles={{
                                  container: (provided) => ({
                                    ...provided,
                                    width: "100%"
                                  }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({
                                    ...provided,
                                    display: "none"
                                  })
                                }}
                              />
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
              {workflowRuns.map((row) => (
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
        </>
      )}
    </Box>
  );
}
