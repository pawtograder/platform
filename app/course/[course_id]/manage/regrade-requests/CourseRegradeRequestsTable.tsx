"use client";

import {
  AppealGrantedCell,
  AssignmentTitleCell,
  RegradeRequestContextLink,
  StatusCell,
  StudentOrGroupLabel,
  statusConfig
} from "@/components/regrade-requests/InstructorRegradeTableShared";
import DiscordMessageLink from "@/components/discord/discord-message-link";
import PersonName from "@/components/ui/person-name";
import { useCustomTable, type ServerNotFilter } from "@/hooks/useCustomTable";
import { useTableControllerTableValues } from "@/lib/TableController";
import type { RegradeStatus } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Checkbox, HStack, Icon, Input, Table, Text, VStack } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { formatRelative } from "date-fns";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { FaSort, FaSortDown, FaSortUp } from "react-icons/fa";
import { useCourseController } from "@/hooks/useCourseController";

type CourseRegradeRequestRow = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_regrade_requests"]["Row"],
  "submission_regrade_requests",
  Database["public"]["Tables"]["submission_regrade_requests"]["Relationships"],
  "*, submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_file_comments_rubric_check_id_fkey(name)), submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_artifact_comments_rubric_check_id_fkey(name)), submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_comments_rubric_check_id_fkey(name)), submissions!inner(id, profiles(name), assignment_groups(assignment_groups_members(profiles!assignment_groups_members_profile_id_fkey(name)))), assignments!inner(id, title)"
>;

function RubricCheckNameCell({ row }: { row: CourseRegradeRequestRow }) {
  const name =
    row.submission_file_comments?.[0]?.rubric_checks?.name ||
    row.submission_artifact_comments?.[0]?.rubric_checks?.name ||
    row.submission_comments?.[0]?.rubric_checks?.name;
  return <Text>{name ?? "—"}</Text>;
}

/**
 * All regrade requests in the course (staff view). Defaults to hiding draft and resolved; optional server filters for those statuses.
 */
export default function CourseRegradeRequestsTable() {
  const { course_id } = useParams();
  const courseIdNum = Number(course_id);
  const courseController = useCourseController();
  const profiles = useTableControllerTableValues(courseController.profiles);

  const [hideResolvedAndDraft, setHideResolvedAndDraft] = useState(true);

  const serverFilters = useMemo(
    () => [{ field: "class_id", operator: "eq" as const, value: course_id as string }],
    [course_id]
  );

  const serverNotFilters = useMemo((): ServerNotFilter[] => {
    if (!hideResolvedAndDraft) return [];
    return [{ field: "status", operator: "in" as const, value: "(draft,resolved)" }];
  }, [hideResolvedAndDraft]);

  const statusOptions = useMemo(
    () =>
      (Object.keys(statusConfig) as RegradeStatus[]).map((value) => ({
        label: statusConfig[value].label,
        value
      })),
    []
  );

  const appealGrantedOptions = useMemo(
    () => [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" }
    ],
    []
  );

  const columns = useMemo<ColumnDef<CourseRegradeRequestRow>[]>(
    () => [
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ getValue }) => <StatusCell status={getValue() as RegradeStatus} />,
        enableColumnFilter: true,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterValues.includes(row.original.status);
        }
      },
      {
        id: "assignment",
        header: "Assignment",
        accessorFn: (row) => row.assignments?.title ?? "",
        cell: ({ row }) => (
          <AssignmentTitleCell
            title={row.original.assignments?.title ?? "—"}
            href={`/course/${courseIdNum}/manage/assignments/${row.original.assignment_id}/regrade-requests`}
          />
        ),
        enableColumnFilter: true,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];
          const title = row.original.assignments?.title ?? "";
          return filterValues.includes(title);
        }
      },
      {
        id: "rubric_check",
        header: "Rubric Check",
        accessorFn: (row) =>
          row.submission_file_comments?.[0]?.rubric_checks?.name ||
          row.submission_artifact_comments?.[0]?.rubric_checks?.name ||
          row.submission_comments?.[0]?.rubric_checks?.name ||
          "",
        cell: ({ row }) => <RubricCheckNameCell row={row.original} />,
        enableColumnFilter: true,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];
          const name =
            row.original.submission_file_comments?.[0]?.rubric_checks?.name ||
            row.original.submission_artifact_comments?.[0]?.rubric_checks?.name ||
            row.original.submission_comments?.[0]?.rubric_checks?.name ||
            "";
          return filterValues.includes(name);
        }
      },
      {
        id: "student",
        header: "Student/Group",
        accessorFn: (row) => {
          if (row.submissions?.assignment_groups?.assignment_groups_members?.length) {
            return `Group: ${row.submissions.assignment_groups.assignment_groups_members
              .map((m) => m.profiles?.name)
              .filter(Boolean)
              .join(", ")}`;
          }
          return row.submissions?.profiles?.name || "Unknown";
        },
        cell: ({ row }) => {
          const submission = row.original.submissions;
          return (
            <HStack align="flex-start">
              <StudentOrGroupLabel
                assignmentGroupsMembers={submission?.assignment_groups?.assignment_groups_members}
                profileName={submission?.profiles?.name}
              />
              <RegradeRequestContextLink
                courseId={courseIdNum}
                assignmentId={row.original.assignment_id}
                submissionId={row.original.submission_id}
                regradeRequestId={row.original.id}
              />
            </HStack>
          );
        },
        enableColumnFilter: true,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];
          let displayName: string;
          if (row.original.submissions?.assignment_groups?.assignment_groups_members?.length) {
            displayName = `Group: ${row.original.submissions.assignment_groups.assignment_groups_members
              .map((m) => m.profiles?.name)
              .filter(Boolean)
              .join(", ")}`;
          } else {
            displayName = row.original.submissions?.profiles?.name || "Unknown";
          }
          return filterValues.includes(displayName);
        }
      },
      {
        id: "assignee",
        accessorKey: "assignee",
        header: "Assignee",
        cell: ({ getValue }) => <PersonName showAvatar={false} uid={getValue() as string} />,
        enableColumnFilter: true,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];
          const assignee = row.original.assignee;
          return assignee ? filterValues.includes(assignee) : false;
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
        header: "Points on Escalation",
        accessorKey: "closed_points",
        cell: ({ getValue }) => getValue() ?? ""
      },
      {
        id: "appeal_granted",
        header: "Escalation Granted",
        accessorFn: (row) => {
          if (row.status !== "closed") return "N/A";
          return (
            row.closed_points !== null && row.resolved_points !== null && row.closed_points !== row.resolved_points
          );
        },
        cell: ({ row }) => (
          <AppealGrantedCell
            status={row.original.status}
            closedPoints={row.original.closed_points}
            resolvedPoints={row.original.resolved_points}
          />
        ),
        enableColumnFilter: true,
        enableSorting: false,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (filterValues.includes("yes")) {
            const isAppealGranted =
              row.original.status === "closed" &&
              row.original.closed_points !== null &&
              row.original.resolved_points !== null &&
              row.original.closed_points !== row.original.resolved_points;
            if (isAppealGranted) return true;
          }

          if (filterValues.includes("no")) {
            const isAppealNotGranted =
              row.original.status === "closed" &&
              (row.original.closed_points === null ||
                row.original.resolved_points === null ||
                row.original.closed_points === row.original.resolved_points);
            if (isAppealNotGranted) return true;
          }

          return false;
        }
      },
      {
        id: "discord",
        header: "Discord",
        cell: ({ row }) => (
          <DiscordMessageLink resourceType="regrade_request" resourceId={row.original.id} size="sm" variant="ghost" />
        ),
        enableColumnFilter: false,
        enableSorting: false
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
        cell: ({ getValue }) => formatRelative(new Date(getValue() as string), new Date())
      }
    ],
    [courseIdNum]
  );

  const selectClause = `
      *,
      submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_file_comments_rubric_check_id_fkey(name)),
      submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_artifact_comments_rubric_check_id_fkey(name)),
      submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_comments_rubric_check_id_fkey(name)),
      submissions!inner(
          id,
          profiles(name),
          assignment_groups(assignment_groups_members(profiles!assignment_groups_members_profile_id_fkey(name)))
      ),
      assignments!inner(id, title)
    `;

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
  } = useCustomTable<CourseRegradeRequestRow>({
    columns,
    resource: "submission_regrade_requests",
    serverFilters,
    serverNotFilters,
    select: selectClause,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      },
      sorting: [{ id: "created_at", desc: true }]
    }
  });

  const assigneeOptions = useMemo(() => {
    if (!data) return [];
    const assignees = new Set<string>();
    data.forEach((row) => {
      if (row.assignee) assignees.add(row.assignee);
    });
    return Array.from(assignees)
      .sort()
      .map((assigneeUid) => {
        const profile = profiles.find((p) => p.id === assigneeUid);
        return { label: profile?.name || assigneeUid, value: assigneeUid };
      });
  }, [data, profiles]);

  const studentOptions = useMemo(() => {
    if (!data) return [];
    const students = new Set<string>();
    data.forEach((row) => {
      let displayName: string;
      if (row.submissions?.assignment_groups?.assignment_groups_members?.length) {
        displayName = `Group: ${row.submissions.assignment_groups.assignment_groups_members
          .map((m) => m.profiles?.name)
          .filter(Boolean)
          .join(", ")}`;
      } else {
        displayName = row.submissions?.profiles?.name || "Unknown";
      }
      students.add(displayName);
    });
    return Array.from(students)
      .sort()
      .map((student) => ({ label: student, value: student }));
  }, [data]);

  const assignmentTitleOptions = useMemo(() => {
    if (!data) return [];
    const titles = new Set<string>();
    data.forEach((row) => {
      const t = row.assignments?.title;
      if (t) titles.add(t);
    });
    return Array.from(titles)
      .sort()
      .map((title) => ({ label: title, value: title }));
  }, [data]);

  const rubricCheckNameOptions = useMemo(() => {
    if (!data) return [];
    const names = new Set<string>();
    data.forEach((row) => {
      const n =
        row.submission_file_comments?.[0]?.rubric_checks?.name ||
        row.submission_artifact_comments?.[0]?.rubric_checks?.name ||
        row.submission_comments?.[0]?.rubric_checks?.name;
      if (n) names.add(n);
    });
    return Array.from(names)
      .sort()
      .map((name) => ({ label: name, value: name }));
  }, [data]);

  const { pagination } = getState();
  const { pageIndex, pageSize } = pagination;
  const totalCount = data?.length || 0;

  return (
    <VStack align="stretch" gap={4}>
      <HStack wrap="wrap" gap={4} align="flex-end">
        <Checkbox.Root
          checked={hideResolvedAndDraft}
          onCheckedChange={(details) => setHideResolvedAndDraft(details.checked === true)}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>Hide draft and resolved</Checkbox.Label>
        </Checkbox.Root>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Filter by Status:
          </Text>
          <Box width="150px">
            <Select
              size="sm"
              placeholder="All statuses"
              value={
                (getColumn("status")?.getFilterValue() as string[])
                  ? statusOptions.filter((opt) =>
                      ((getColumn("status")?.getFilterValue() as string[]) || []).includes(opt.value)
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("status")?.setFilterValue(values.length > 0 ? values : undefined);
              }}
              options={statusOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Assignment:
          </Text>
          <Box width="220px">
            <Select
              size="sm"
              placeholder="All assignments"
              value={
                (getColumn("assignment")?.getFilterValue() as string[])
                  ? assignmentTitleOptions.filter((opt) =>
                      ((getColumn("assignment")?.getFilterValue() as string[]) || []).includes(opt.value)
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("assignment")?.setFilterValue(values.length > 0 ? values : undefined);
              }}
              options={assignmentTitleOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Filter by Student:
          </Text>
          <Box width="200px">
            <Select
              size="sm"
              placeholder="All students"
              value={
                (getColumn("student")?.getFilterValue() as string[])
                  ? studentOptions.filter((opt) =>
                      ((getColumn("student")?.getFilterValue() as string[]) || []).includes(opt.value)
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("student")?.setFilterValue(values.length > 0 ? values : undefined);
              }}
              options={studentOptions}
              isClearable
              isMulti
            />
          </Box>
        </Box>

        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Escalation Granted:
          </Text>
          <Box width="120px">
            <Select
              size="sm"
              placeholder="All"
              value={
                (getColumn("appeal_granted")?.getFilterValue() as string[])
                  ? appealGrantedOptions.filter((opt) =>
                      ((getColumn("appeal_granted")?.getFilterValue() as string[]) || []).includes(opt.value)
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("appeal_granted")?.setFilterValue(values.length > 0 ? values : undefined);
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
                (getColumn("rubric_check")?.getFilterValue() as string[])
                  ? rubricCheckNameOptions.filter((opt) =>
                      ((getColumn("rubric_check")?.getFilterValue() as string[]) || []).includes(opt.value)
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("rubric_check")?.setFilterValue(values.length > 0 ? values : undefined);
              }}
              options={rubricCheckNameOptions}
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
                (getColumn("assignee")?.getFilterValue() as string[])
                  ? assigneeOptions.filter((opt) =>
                      ((getColumn("assignee")?.getFilterValue() as string[]) || []).includes(opt.value)
                    )
                  : []
              }
              onChange={(options) => {
                const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
                getColumn("assignee")?.setFilterValue(values.length > 0 ? values : undefined);
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

      {isLoading && (
        <Text textAlign="center" color="fg.muted">
          Loading regrade requests...
        </Text>
      )}

      {error && (
        <Text textAlign="center" color="red.500">
          Error loading data: {error.message}
        </Text>
      )}

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
