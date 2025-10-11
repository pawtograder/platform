"use client";

import {
  Box,
  Heading,
  Text,
  Icon,
  IconButton,
  HStack,
  Link,
  Button,
  VStack,
  NativeSelect,
  Spinner
} from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
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

function WorkflowRunTable() {
  const { course_id } = useParams();
  const supabase = useMemo(() => createClient(), []);
  const {
    classRealTimeController,
    assignments: assignmentsController,
    profiles: profilesController
  } = useCourseController();

  // Get data from TableControllers
  const assignmentsData = assignmentsController.rows;
  const profilesData = profilesController.rows;

  // Create maps for quick lookups
  const assignments = useMemo(() => {
    const map = new Map<number, string>();
    assignmentsData.forEach((assignment) => {
      map.set(assignment.id, assignment.title);
    });
    return map;
  }, [assignmentsData]);

  const profiles = useMemo(() => {
    const map = new Map<string, string>();
    profilesData.forEach((profile) => {
      if (profile.name) {
        map.set(profile.id, profile.name);
      }
    });
    return map;
  }, [profilesData]);

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
        id: "assignment_id",
        accessorKey: "assignment_id",
        header: "Assignment",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunRow, unknown>) => {
          const assignmentId = getValue() as number | null;
          if (!assignmentId) return <Text fontSize="sm">-</Text>;
          const assignmentName = assignments.get(assignmentId);
          return <Text fontSize="sm">{assignmentName || `Assignment #${assignmentId}`}</Text>;
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const assignmentId = row.original.assignment_id;
          if (!assignmentId) return false;
          const assignmentName = assignments.get(assignmentId) || String(assignmentId);
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => assignmentName.toLowerCase().includes(filter.toLowerCase()));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignments, profiles]
  );

  const [tableController, setTableController] = useState<TableController<"workflow_runs"> | undefined>(undefined);

  useEffect(() => {
    const query = supabase
      .from("workflow_runs")
      .select("*")
      .eq("class_id", Number(course_id))
      .order("requested_at", { ascending: false })
      .limit(1000);

    const tc = new TableController({
      query: query,
      client: supabase,
      table: "workflow_runs",
      classRealTimeController,
      loadEntireTable: false
    });

    setTableController(tc);

    return () => {
      tc.close();
    };
  }, [supabase, course_id, classRealTimeController]);

  const {
    getHeaderGroups,
    getRowModel,
    getState,
    getRowCount,
    setPageIndex,
    getCanPreviousPage,
    getPageCount,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    isLoading,
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

  // Use getRowModel for displaying filtered data
  const filteredWorkflowRuns = getRowModel().rows;

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

      {isLoading ? (
        <Box p={6} borderRadius="md" textAlign="center">
          <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
            <Spinner size="lg" />
            <Text>Loading workflow runs...</Text>
          </VStack>
        </Box>
      ) : filteredWorkflowRuns.length === 0 && data.length === 0 ? (
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
                            {header.id === "workflow_run_id" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const runId = row.workflow_run_id;
                                      if (runId && !map.has(runId)) {
                                        map.set(runId, runId);
                                      }
                                      return map;
                                    }, new Map<number, number>())
                                    .values()
                                ).map((runId) => ({ label: `#${runId}`, value: String(runId) }))}
                                placeholder="Filter Run ID..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({
                                        label: `#${v}`,
                                        value: v
                                      }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
                                }}
                              />
                            )}
                            {header.id === "profile_id" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const profileId = row.profile_id;
                                      if (profileId && !map.has(profileId)) {
                                        const profileName = profiles.get(profileId) || profileId;
                                        map.set(profileId, profileName);
                                      }
                                      return map;
                                    }, new Map<string, string>())
                                    .entries()
                                )
                                  .sort((a, b) => a[1].localeCompare(b[1]))
                                  .map(([id, name]) => ({ label: name, value: id }))}
                                placeholder="Filter Student..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => {
                                        const name = profiles.get(v) || v;
                                        return { label: name, value: v };
                                      })
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
                                }}
                              />
                            )}
                            {header.id === "assignment_id" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const assignmentId = row.assignment_id;
                                      if (assignmentId && !map.has(assignmentId)) {
                                        const assignmentName =
                                          assignments.get(assignmentId) || `Assignment #${assignmentId}`;
                                        map.set(assignmentId, assignmentName);
                                      }
                                      return map;
                                    }, new Map<number, string>())
                                    .entries()
                                )
                                  .sort((a, b) => a[1].localeCompare(b[1]))
                                  .map(([, name]) => ({ label: name, value: name }))}
                                placeholder="Filter by assignment..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({ label: v, value: v }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
                                }}
                              />
                            )}
                            {header.id === "actor_login" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const actor = row.actor_login || "Unknown";
                                      if (!map.has(actor)) {
                                        map.set(actor, actor);
                                      }
                                      return map;
                                    }, new Map<string, string>())
                                    .values()
                                )
                                  .sort()
                                  .map((actor) => ({ label: actor, value: actor }))}
                                placeholder="Filter by actor..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({ label: v, value: v }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
                                }}
                              />
                            )}
                            {header.id === "head_sha" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const sha = row.head_sha;
                                      if (sha && !map.has(sha)) {
                                        map.set(sha, sha);
                                      }
                                      return map;
                                    }, new Map<string, string>())
                                    .values()
                                )
                                  .sort()
                                  .map((sha) => ({ label: sha.substring(0, 7), value: sha }))}
                                placeholder="Filter by commit..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({
                                        label: v.substring(0, 7),
                                        value: v
                                      }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
                                }}
                              />
                            )}
                            {header.id === "status" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const { requested_at, in_progress_at, completed_at } = row;
                                      let status = "unknown";
                                      if (completed_at) status = "completed";
                                      else if (in_progress_at) status = "in progress";
                                      else if (requested_at) status = "requested";
                                      if (!map.has(status)) {
                                        map.set(status, status);
                                      }
                                      return map;
                                    }, new Map<string, string>())
                                    .values()
                                ).map((status) => ({
                                  label: status.charAt(0).toUpperCase() + status.slice(1),
                                  value: status
                                }))}
                                placeholder="Filter by status..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({
                                        label: v.charAt(0).toUpperCase() + v.slice(1),
                                        value: v
                                      }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
                                }}
                              />
                            )}
                            {header.id === "run_number" && (
                              <CreatableSelect
                                isMulti
                                name={header.id}
                                options={Array.from(
                                  data
                                    .reduce((map, row) => {
                                      const runNumber = row.run_number;
                                      if (runNumber && !map.has(runNumber)) {
                                        map.set(runNumber, runNumber);
                                      }
                                      return map;
                                    }, new Map<number, number>())
                                    .values()
                                )
                                  .sort((a, b) => a - b)
                                  .map((runNumber) => ({ label: String(runNumber), value: String(runNumber) }))}
                                placeholder="Filter Run #..."
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({ label: v, value: v }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(
                                    selected && selected.length > 0 ? selected.map((option) => option.value) : undefined
                                  );
                                }}
                                chakraStyles={{
                                  container: (provided) => ({ ...provided, width: "100%" }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({ ...provided, display: "none" })
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
              {filteredWorkflowRuns.map((row) => (
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
          <VStack w="100%" gap={4} mt={4}>
            <HStack>
              <Button onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
                {"<<"}
              </Button>
              <Button id="previous-button" onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
                {"<"}
              </Button>
              <Button id="next-button" onClick={() => nextPage()} disabled={!getCanNextPage()}>
                {">"}
              </Button>
              <Button onClick={() => setPageIndex(getPageCount() - 1)} disabled={!getCanNextPage()}>
                {">>"}
              </Button>
              <VStack gap={1}>
                <Text fontSize="sm">Page</Text>
                <Text fontSize="sm" fontWeight="medium">
                  {getState().pagination.pageIndex + 1} of {getPageCount()}
                </Text>
              </VStack>
              <VStack gap={1}>
                <Text fontSize="sm">Go to page:</Text>
                <input
                  title="Go to page"
                  type="number"
                  defaultValue={getState().pagination.pageIndex + 1}
                  onChange={(e) => {
                    const page = e.target.value ? Number(e.target.value) - 1 : 0;
                    setPageIndex(page);
                  }}
                  style={{
                    width: "80px",
                    padding: "4px 8px",
                    borderRadius: "4px",
                    border: "1px solid #e2e8f0"
                  }}
                />
              </VStack>
              <VStack gap={1}>
                <Text fontSize="sm">Show</Text>
                <NativeSelect.Root title="Select page size" width="120px">
                  <NativeSelect.Field
                    value={"" + getState().pagination.pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                    }}
                  >
                    {[10, 25, 50, 100, 200, 500, 1000].map((pageSize) => (
                      <option key={pageSize} value={pageSize}>
                        Show {pageSize}
                      </option>
                    ))}
                  </NativeSelect.Field>
                </NativeSelect.Root>
              </VStack>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              {getRowCount()} Workflow Runs Total
            </Text>
          </VStack>
        </>
      )}
    </Box>
  );
}
