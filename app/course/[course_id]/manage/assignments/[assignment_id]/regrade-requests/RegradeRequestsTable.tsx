"use client";

import PersonName from "@/components/ui/person-name";
import type { RegradeStatus } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, HStack, Icon, Input, Table, Tag, Text, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useCustomTable } from "@/hooks/useCustomTable";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { formatRelative } from "date-fns";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { FaExternalLinkAlt, FaSort, FaSortDown, FaSortUp, FaCheck, FaTimes } from "react-icons/fa";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { useAssignmentController, useRubricCheck } from "@/hooks/useAssignment";

// Status configuration
const statusConfig: Record<
  RegradeStatus,
  {
    colorPalette: string;
    icon: LucideIcon;
    label: string;
  }
> = {
  draft: {
    colorPalette: "gray",
    icon: Clock,
    label: "Draft"
  },
  opened: {
    colorPalette: "orange",
    icon: AlertCircle,
    label: "Pending"
  },
  resolved: {
    colorPalette: "blue",
    icon: CheckCircle,
    label: "Resolved"
  },
  escalated: {
    colorPalette: "red",
    icon: ArrowUp,
    label: "Appealed"
  },
  closed: {
    colorPalette: "gray",
    icon: XCircle,
    label: "Closed"
  }
};

// Type for regrade request with populated relations
type RegradeRequestRow = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_regrade_requests"]["Row"],
  "submission_regrade_requests",
  Database["public"]["Tables"]["submission_regrade_requests"]["Relationships"],
  "*, submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id), submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id), submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id), submissions!inner(id, profiles(name), assignment_groups(assignment_groups_members(profiles!assignment_groups_members_profile_id_fkey(name))))"
>;

/**
 * Renders a status tag with an icon and label corresponding to the given regrade request status.
 *
 * @param status - The status of the regrade request to display.
 */
function StatusCell({ status }: { status: RegradeStatus }) {
  const config = statusConfig[status];
  const StatusIcon = config.icon;

  return (
    <Tag.Root colorPalette={config.colorPalette} variant="surface">
      <HStack gap={1}>
        <Icon as={StatusIcon} boxSize={3} />
        <Tag.Label>{config.label}</Tag.Label>
      </HStack>
    </Tag.Root>
  );
}

/**
 * Renders the student or group name associated with a submission, along with a button to open the submission details page in a new tab.
 *
 * If the submission is part of a group, displays the group members' names; otherwise, displays the individual student's name or "Unknown" if unavailable.
 *
 * @param submissionId - The unique identifier of the submission to link to.
 */
function StudentCell({
  submission,
  submissionId
}: {
  submission?: RegradeRequestRow["submissions"];
  submissionId: number;
}) {
  const { course_id, assignment_id } = useParams();

  let displayName = "Unknown";
  if (submission?.assignment_groups?.assignment_groups_members?.length) {
    displayName = `Group: ${submission.assignment_groups.assignment_groups_members.map((member) => member.profiles.name).join(", ")}`;
  } else if (submission?.profiles?.name) {
    displayName = submission.profiles.name;
  }

  return (
    <HStack>
      <Text>{displayName}</Text>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          window.open(`/course/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`, "_blank");
        }}
      >
        <Icon as={FaExternalLinkAlt} boxSize={3} />
      </Button>
    </HStack>
  );
}

/**
 * Displays whether an appeal was granted for a closed regrade request.
 *
 * Shows "Yes" with a green check icon if the closed points differ from the resolved points, "No" with a red cross if they are equal, and "N/A" if the request is not closed.
 */
function AppealGrantedCell({ row }: { row: RegradeRequestRow }) {
  const isAppealGranted =
    row.status === "closed" &&
    row.closed_points !== null &&
    row.resolved_points !== null &&
    row.closed_points !== row.resolved_points;

  if (row.status !== "closed") {
    return <Text color="fg.muted">N/A</Text>;
  }

  return (
    <HStack gap={1}>
      <Icon as={isAppealGranted ? FaCheck : FaTimes} boxSize={3} color={isAppealGranted ? "green.500" : "red.500"} />
      <Text color={isAppealGranted ? "green.500" : "red.500"}>{isAppealGranted ? "Yes" : "No"}</Text>
    </HStack>
  );
}

/**
 * Displays the name of the rubric check associated with a regrade request row.
 *
 * Determines the rubric check ID from the first available comment in the row and fetches its details to display the rubric check name.
 */
function RubricCheckCell({ row }: { row: RegradeRequestRow }) {
  const rubricCheckId =
    row.submission_file_comments?.[0]?.rubric_check_id ||
    row.submission_artifact_comments?.[0]?.rubric_check_id ||
    row.submission_comments?.[0]?.rubric_check_id;
  const rubricCheck = useRubricCheck(rubricCheckId);
  return <Text>{rubricCheck?.name}</Text>;
}

/**
 * Displays a filterable, sortable, and paginated table of regrade requests for a specific assignment.
 *
 * Provides interactive controls to filter by status, student/group, appeal granted, and rubric check. Integrates with Supabase to fetch regrade request data and related entities, and renders detailed information for each request including status, student/group, rubric check, points, and appeal outcome.
 *
 * The table supports sorting, multi-column filtering, and navigation through large result sets with pagination controls.
 */
export default function RegradeRequestsTable() {
  const { assignment_id } = useParams();
  const assignmentController = useAssignmentController();

  // Get all rubric checks for the assignment
  const allRubricChecks = useMemo(() => {
    if (!assignmentController.isReady) return [];
    return Array.from(assignmentController.rubricCheckById.values());
  }, [assignmentController]);

  // Create options for status filter
  const statusOptions = useMemo(
    () => [
      { label: "Draft", value: "draft" },
      { label: "Pending", value: "opened" },
      { label: "Resolved", value: "resolved" },
      { label: "Appealed", value: "escalated" },
      { label: "Closed", value: "closed" }
    ],
    []
  );

  // Create options for appeal granted filter
  const appealGrantedOptions = useMemo(
    () => [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" }
    ],
    []
  );

  // Create options for rubric check filter
  const rubricCheckOptions = useMemo(
    () =>
      allRubricChecks.map((check) => ({
        label: check.name,
        value: check.id.toString()
      })),
    [allRubricChecks]
  );

  // Server filters for initial data fetching
  const serverFilters = useMemo(
    () => [{ field: "assignment_id", operator: "eq" as const, value: assignment_id as string }],
    [assignment_id]
  );

  const columns = useMemo<ColumnDef<RegradeRequestRow>[]>(
    () => [
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ getValue }) => <StatusCell status={getValue() as RegradeStatus} />,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          return row.original.status === filterValue;
        }
      },
      {
        id: "rubric_check",
        header: "Rubric Check",
        cell: ({ row }) => <RubricCheckCell row={row.original} />,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue) return true;
          const rubricCheckId =
            row.original.submission_file_comments?.[0]?.rubric_check_id ||
            row.original.submission_artifact_comments?.[0]?.rubric_check_id ||
            row.original.submission_comments?.[0]?.rubric_check_id;
          return rubricCheckId === parseInt(filterValue as string);
        }
      },
      {
        id: "student",
        header: "Student/Group",
        accessorFn: (row) => {
          if (row.submissions?.assignment_groups?.assignment_groups_members?.length) {
            return `Group: ${row.submissions.assignment_groups.assignment_groups_members.map((member) => member.profiles.name).join(", ")}`;
          }
          return row.submissions?.profiles?.name || "Unknown";
        },
        cell: ({ row }) => (
          <StudentCell submission={row.original.submissions} submissionId={row.original.submission_id} />
        ),
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const filterString = String(filterValue).toLowerCase();
          const studentName = row.original.submissions?.profiles?.name?.toLowerCase();
          const groupMembers = row.original.submissions?.assignment_groups?.assignment_groups_members;
          const groupNames = groupMembers
            ?.map((member) => member.profiles.name)
            .join(", ")
            .toLowerCase();

          if (studentName && studentName.includes(filterString)) return true;
          if (groupNames && groupNames.includes(filterString)) return true;
          return false;
        }
      },
      {
        id: "assignee",
        accessorKey: "assignee",
        header: "Assignee",
        cell: ({ getValue }) => <PersonName showAvatar={false} uid={getValue() as string} />,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue) return true;
          const filterString = String(filterValue).toLowerCase();
          const assignee = row.original.assignee?.toLowerCase();
          return assignee ? assignee.includes(filterString) : false;
        }
      },
      {
        id: "initial_points",
        accessorKey: "initial_points",
        header: "Initial Points",
        cell: ({ getValue }) => getValue() ?? "N/A"
      },
      {
        id: "resolved_points",
        header: "Resolved Points",
        accessorKey: "resolved_points",
        cell: ({ getValue }) => getValue() ?? ""
      },
      {
        id: "closed_points",
        header: "Points on Appeal",
        accessorKey: "closed_points",
        cell: ({ getValue }) => getValue() ?? ""
      },
      {
        id: "appeal_granted",
        header: "Appeal Granted",
        accessorFn: (row) => {
          if (row.status !== "closed") return "N/A";
          return (
            row.status === "closed" &&
            row.closed_points !== null &&
            row.resolved_points !== null &&
            row.closed_points !== row.resolved_points
          );
        },
        cell: ({ row }) => <AppealGrantedCell row={row.original} />,
        enableColumnFilter: true,
        enableSorting: false,
        filterFn: (row, id, filterValue) => {
          if (filterValue === "yes") {
            return (
              row.original.status === "closed" &&
              row.original.closed_points !== null &&
              row.original.resolved_points !== null &&
              row.original.closed_points !== row.original.resolved_points
            );
          }
          if (filterValue === "no") {
            return (
              row.original.status === "closed" &&
              (row.original.closed_points === null ||
                row.original.resolved_points === null ||
                row.original.closed_points === row.original.resolved_points)
            );
          }
          return true;
        }
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Created",
        cell: ({ getValue }) => formatRelative(new Date(getValue() as string), new Date())
      },
      {
        id: "last_updated_at",
        accessorKey: "last_updated_at",
        header: "Last Updated",
        cell: ({ getValue }) => {
          return formatRelative(new Date(getValue() as string), new Date());
        }
      }
    ],
    []
  );

  const {
    getHeaderGroups,
    getRowModel,
    data,
    isLoading,
    error,
    resetColumnFilters,
    getColumn,
    getCanPreviousPage,
    getCanNextPage,
    resetSorting,
    getPageCount,
    getState,
    setPageIndex
  } = useCustomTable<RegradeRequestRow>({
    columns,
    resource: "submission_regrade_requests",
    serverFilters,
    select: `
      *,
      submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id),
      submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id),
      submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id),
      submissions!inner(
          id,
          profiles(name),
          assignment_groups(assignment_groups_members(profiles!assignment_groups_members_profile_id_fkey(name)))
      )
    `,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 500
      },
      sorting: [{ id: "created_at", desc: false }]
    }
  });

  // Create options for assignee filter
  const assigneeOptions = useMemo(() => {
    if (!data) return [];

    const assignees = new Set<string>();
    data.forEach((row) => {
      if (row.assignee) {
        assignees.add(row.assignee);
      }
    });

    return Array.from(assignees)
      .sort()
      .map((assignee) => ({
        label: assignee,
        value: assignee
      }));
  }, [data]);

  // Get pagination state
  const { pagination } = getState();
  const { pageIndex, pageSize } = pagination;
  const totalCount = data?.length || 0;

  return (
    <VStack align="stretch" gap={4}>
      {/* Filters */}
      <HStack wrap="wrap" gap={4}>
        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Filter by Status:
          </Text>
          <Box width="150px">
            <Select
              size="sm"
              placeholder="All statuses"
              value={
                (getColumn("status")?.getFilterValue() as string)
                  ? statusOptions.filter((opt) => (getColumn("status")?.getFilterValue() as string) === opt.value)
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("status")?.setFilterValue(values.length > 0 ? values[0] : undefined);
              }}
              options={statusOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Filter by Student:
          </Text>
          <Input
            placeholder="Search students..."
            value={(getColumn("student")?.getFilterValue() as string) || ""}
            onChange={(e) => getColumn("student")?.setFilterValue(e.target.value)}
            size="sm"
            width="200px"
          />
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Appeal Granted:
          </Text>
          <Box width="120px">
            <Select
              size="sm"
              placeholder="All"
              value={
                (getColumn("appeal_granted")?.getFilterValue() as string)
                  ? appealGrantedOptions.filter(
                      (opt) => (getColumn("appeal_granted")?.getFilterValue() as string) === opt.value
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("appeal_granted")?.setFilterValue(values.length > 0 ? values[0] : undefined);
              }}
              options={appealGrantedOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Rubric Check:
          </Text>
          <Box width="200px">
            <Select
              size="sm"
              placeholder="All rubric checks"
              value={
                (getColumn("rubric_check")?.getFilterValue() as string)
                  ? rubricCheckOptions.filter(
                      (opt) => (getColumn("rubric_check")?.getFilterValue() as string) === opt.value
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("rubric_check")?.setFilterValue(values.length > 0 ? values[0] : undefined);
              }}
              options={rubricCheckOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Filter by Assignee:
          </Text>
          <Box width="200px">
            <Select
              size="sm"
              placeholder="All assignees"
              value={
                (getColumn("assignee")?.getFilterValue() as string)
                  ? assigneeOptions.filter((opt) => (getColumn("assignee")?.getFilterValue() as string) === opt.value)
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("assignee")?.setFilterValue(values.length > 0 ? values[0] : undefined);
              }}
              options={assigneeOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetColumnFilters();
              resetSorting();
            }}
          >
            Clear Filters
          </Button>
        </Box>
      </HStack>

      {/* Loading state */}
      {isLoading && (
        <Text textAlign="center" color="fg.muted">
          Loading regrade requests...
        </Text>
      )}

      {/* Error state */}
      {error && (
        <Text textAlign="center" color="red.500">
          Error loading data: {error.message}
        </Text>
      )}

      {/* Table */}
      <Box overflowX="auto">
        <Table.Root size="sm">
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader key={header.id}>
                    {header.isPlaceholder ? null : (
                      <HStack
                        cursor={header.column.getCanSort() ? "pointer" : "default"}
                        onClick={header.column.getToggleSortingHandler()}
                        userSelect="none"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <Icon
                            as={
                              header.column.getIsSorted() === "desc"
                                ? FaSortDown
                                : header.column.getIsSorted() === "asc"
                                  ? FaSortUp
                                  : FaSort
                            }
                            boxSize={3}
                          />
                        )}
                      </HStack>
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

      {/* Pagination */}
      <HStack justifyContent="space-between" alignItems="center">
        <Text fontSize="sm" color="fg.muted">
          Showing {Math.min(pageIndex * pageSize + 1, totalCount)} to {Math.min((pageIndex + 1) * pageSize, totalCount)}{" "}
          of {totalCount} results
        </Text>

        <HStack>
          <Button
            variant="outline"
            size="sm"
            onClick={() => getCanPreviousPage() && setPageIndex(pageIndex - 1)}
            disabled={!getCanPreviousPage()}
          >
            Previous
          </Button>

          <HStack gap={1}>
            <Text fontSize="sm">Page</Text>
            <Input
              size="sm"
              width="60px"
              value={pageIndex + 1}
              onChange={(e) => {
                const page = parseInt(e.target.value, 10) - 1;
                if (!isNaN(page) && page >= 0 && page < getPageCount()) {
                  setPageIndex(page);
                }
              }}
            />
            <Text fontSize="sm">of {getPageCount()}</Text>
          </HStack>

          <Button
            variant="outline"
            size="sm"
            onClick={() => getCanNextPage() && setPageIndex(pageIndex + 1)}
            disabled={!getCanNextPage()}
          >
            Next
          </Button>
        </HStack>
      </HStack>
    </VStack>
  );
}
