"use client";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import { useMemo } from "react";
import type { ColumnDef, Row } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Table, Spinner, Text } from "@chakra-ui/react";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { useCourseController } from "@/hooks/useCourseController";
import { useParams, useRouter } from "next/navigation";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import PersonName from "@/components/ui/person-name";
import { useClassProfiles } from "@/hooks/useClassProfiles";

type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"] & {
  submissions: {
    id: number;
    profiles?: {
      id: string;
      name: string;
    };
    assignment_groups?: {
      id: number;
      name: string;
    };
  };
  profiles: {
    id: string;
    name: string;
  };
};

export default function ReviewAssignmentsTable() {
  const { assignment_id, course_id } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const { private_profile_id } = useClassProfiles();
  const { classRealTimeController } = useCourseController();

  // Handle row click to navigate to submission review
  const handleRowClick = (row: ReviewAssignmentRow) => {
    const submissionId = row.submission_id;
    const reviewAssignmentId = row.id;
    const url = `/course/${course_id}/assignments/${assignment_id}/submissions/${submissionId}?review_assignment_id=${reviewAssignmentId}`;
    router.push(url);
  };

  // Create a TableController with the necessary joins for populated data
  const tableController = useMemo(() => {
    const query = supabase
      .from("review_assignments")
      .select(
        `
        *,
        profiles!assignee_profile_id(id, name),
        submissions(
          id,
          profiles!profile_id(id, name),
          assignment_groups(id, name)
        )
      `
      )
      .eq("assignment_id", Number(assignment_id))
      .eq("assignee_profile_id", private_profile_id);

    return new TableController<
      "review_assignments",
      "*, profiles!assignee_profile_id(id, name), submissions(id, profiles!profile_id(id, name), assignment_groups(id, name))",
      number
    >({
      query,
      client: supabase,
      table: "review_assignments",
      classRealTimeController
    });
  }, [supabase, assignment_id, classRealTimeController, private_profile_id]);

  const columns = useMemo<ColumnDef<ReviewAssignmentRow>[]>(
    () => [
      {
        id: "assignment_id_filter",
        accessorKey: "assignment_id",
        header: "Assignment ID",
        enableHiding: true,
        filterFn: (row: Row<ReviewAssignmentRow>, id: string, filterValue: string | number) => {
          return String(row.original.assignment_id) === String(filterValue);
        }
      },
      {
        id: "student_or_group",
        header: "Student/Group",
        accessorFn: (row: ReviewAssignmentRow) => {
          const submission = row.submissions;
          if (submission?.assignment_groups?.name) {
            return `Group: ${submission.assignment_groups.name}`;
          }
          if (submission?.profiles?.name) {
            return submission.profiles.name;
          }
          return "Unknown";
        },
        cell: function render({ row }: { row: Row<ReviewAssignmentRow> }) {
          const submission = row.original.submissions;
          if (submission?.assignment_groups?.name) {
            return <Badge variant="outline">Group: {submission.assignment_groups.name}</Badge>;
          }
          if (submission?.profiles?.name) {
            return <PersonName uid={submission.profiles.id} />;
          }
          return <span>Unknown</span>;
        },
        enableColumnFilter: true,
        enableSorting: true
      },
      {
        id: "due_date",
        header: "Due Date",
        accessorKey: "due_date",
        cell: function render({ row }: { row: Row<ReviewAssignmentRow> }) {
          const dueDate = new Date(row.original.due_date);
          return (
            <span>
              {dueDate.toLocaleDateString()} {dueDate.toLocaleTimeString()}
            </span>
          );
        },
        enableColumnFilter: true,
        enableSorting: true
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row: ReviewAssignmentRow) => (row.completed_at ? "Completed" : "Pending"),
        cell: function render({ row }: { row: Row<ReviewAssignmentRow> }) {
          const isCompleted = !!row.original.completed_at;
          return <Badge variant={isCompleted ? "default" : "secondary"}>{isCompleted ? "Completed" : "Pending"}</Badge>;
        },
        enableColumnFilter: true,
        enableSorting: true,
        filterFn: (row: Row<ReviewAssignmentRow>, id: string, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const status = row.original.completed_at ? "Completed" : "Pending";
          return filterValue.includes(status);
        }
      }
    ],
    []
  );

  const table = useTableControllerTable<
    "review_assignments",
    "*, profiles!assignee_profile_id(id, name), submissions(id, profiles!profile_id(id, name), assignment_groups(id, name))"
  >({
    columns,
    tableController,
    initialState: {
      columnVisibility: {
        assignment_id_filter: false
      },
      columnFilters: [{ id: "assignment_id_filter", value: assignment_id as string }],
      pagination: {
        pageIndex: 0,
        pageSize: 50
      },
      sorting: [{ id: "due_date", desc: false }]
    }
  });

  const { getHeaderGroups, getRowModel, isLoading, error } = table;

  if (isLoading) {
    return <Spinner />;
  }

  if (error) {
    return <Text color="red.500">Error loading review assignments: {error.message}</Text>;
  }

  const headerGroups = getHeaderGroups();
  const rows = getRowModel().rows;

  if (rows.length === 0) {
    return <Text>You do not have any grading assigned to you for this assignment yet.</Text>;
  }

  return (
    <Table.Root size="sm" variant="outline">
      <Table.Header>
        {headerGroups.map((headerGroup) => (
          <Table.Row key={headerGroup.id}>
            {headerGroup.headers
              .filter((header) => header.column.getIsVisible())
              .map((header) => (
                <Table.ColumnHeader key={header.id}>
                  {header.isPlaceholder ? null : (
                    <div
                      style={{
                        cursor: header.column.getCanSort() ? "pointer" : "default",
                        userSelect: "none"
                      }}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {typeof header.column.columnDef.header === "function"
                        ? header.column.columnDef.header(header.getContext())
                        : header.column.columnDef.header}
                      {{
                        asc: " ↑",
                        desc: " ↓"
                      }[header.column.getIsSorted() as string] ?? null}
                    </div>
                  )}
                </Table.ColumnHeader>
              ))}
          </Table.Row>
        ))}
      </Table.Header>
      <Table.Body>
        {rows.map((row) => (
          <Table.Row
            key={row.id}
            _hover={{ bg: "bg.subtle", textDecoration: "underline" }}
            cursor="pointer"
            onClick={() => handleRowClick(row.original)}
          >
            {row.getVisibleCells().map((cell) => (
              <Table.Cell key={cell.id}>
                {typeof cell.column.columnDef.cell === "function"
                  ? cell.column.columnDef.cell(cell.getContext())
                  : (cell.getValue() as React.ReactNode)}
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}
