"use client";

import { useMemo, useCallback } from "react";
import { IconButton, HStack, Table, Text, Spinner, Input, NativeSelect, VStack } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { useTable } from "@refinedev/react-table";
import { ColumnDef, flexRender, Row } from "@tanstack/react-table";
import { FaTrash, FaEdit } from "react-icons/fa";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import PersonName from "@/components/ui/person-name";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { TZDate } from "@date-fns/tz";
import { useCourse } from "@/hooks/useAuthState";

// Type definitions
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type AssignmentRow = Database["public"]["Tables"]["assignments"]["Row"];
type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type SubmissionReviewRow = Database["public"]["Tables"]["submission_reviews"]["Row"];

type PopulatedSubmission = SubmissionRow & {
  profiles?: ProfileRow;
  assignment_groups?: AssignmentGroupRow & {
    assignment_groups_members?: { profiles: ProfileRow }[];
  };
  assignments?: AssignmentRow;
  submission_reviews?: SubmissionReviewRow[];
};

export type PopulatedReviewAssignment = ReviewAssignmentRow & {
  profiles?: ProfileRow;
  submissions?: PopulatedSubmission;
  rubrics?: RubricRow;
  review_assignment_rubric_parts?: { rubric_part_id: number }[];
};

interface ReviewsTableProps {
  assignmentId: string | number;
  openAssignModal: (data: PopulatedReviewAssignment | null) => void;
  onReviewAssignmentDeleted: () => void;
}

export default function ReviewsTable({ assignmentId, openAssignModal, onReviewAssignmentDeleted }: ReviewsTableProps) {
  const { mutate: deleteReviewAssignment } = useDelete();
  const course = useCourse();

  const handleDelete = useCallback(
    (id: number) => {
      deleteReviewAssignment(
        {
          resource: "review_assignments",
          id: id
        },
        {
          onSuccess: () => {
            toaster.success({ title: "Review assignment deleted" });
            onReviewAssignmentDeleted();
          },
          onError: (error) => {
            toaster.error({ title: "Error deleting review assignment", description: error.message });
          }
        }
      );
    },
    [deleteReviewAssignment, onReviewAssignmentDeleted]
  );

  const getReviewStatus = useCallback((ra: PopulatedReviewAssignment): string => {
    if (!ra.submissions || !ra.submissions.submission_reviews) {
      if (ra.due_date && new Date(ra.due_date) < new Date()) {
        return "Late";
      }
      return "Pending";
    }

    const matchingReview = ra.submissions.submission_reviews.find(
      (sr: SubmissionReviewRow) =>
        sr.submission_id === ra.submission_id && sr.grader === ra.assignee_profile_id && sr.rubric_id === ra.rubric_id
    );

    if (matchingReview) {
      if (matchingReview.completed_at) {
        return "Completed";
      }
      if (ra.due_date && new Date(ra.due_date) < new Date()) {
        return "Late";
      }
      return "In Progress";
    }

    if (ra.due_date && new Date(ra.due_date) < new Date()) {
      return "Late";
    }
    return "Pending";
  }, []);

  const columns = useMemo<ColumnDef<PopulatedReviewAssignment>[]>(
    () => [
      {
        id: "assignment_id_filter_col",
        accessorKey: "assignment_id",
        header: "Assignment ID",
        enableHiding: true, // Allow hiding
        filterFn: (row: Row<PopulatedReviewAssignment>, id: string, filterValue: string | number) => {
          return String(row.original.assignment_id) === String(filterValue);
        }
      },
      {
        id: "assignee",
        header: "Assignee",
        accessorFn: (row: PopulatedReviewAssignment) => row.profiles?.name || row.assignee_profile_id,
        cell: function render({ row }: { row: Row<PopulatedReviewAssignment> }) {
          return row.original.profiles?.name ? (
            <PersonName uid={row.original.assignee_profile_id} />
          ) : (
            row.original.assignee_profile_id
          );
        },
        enableColumnFilter: true,
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string) => {
          const assigneeName = row.original.profiles?.name;
          const assigneeId = String(row.original.assignee_profile_id);
          const filterString = String(filterValue).toLowerCase();
          if (assigneeName && assigneeName.toLowerCase().includes(filterString)) return true;
          return assigneeId.toLowerCase().includes(filterString);
        }
      },
      {
        id: "submission",
        header: "Submission (Student/Group)",
        accessorFn: (row: PopulatedReviewAssignment) => {
          const submission = row.submissions;
          if (submission) {
            if (submission.assignment_groups?.name) return `Group: ${submission.assignment_groups.name}`;
            if (submission.profiles?.name) return submission.profiles.name;
            return `Submission ID: ${submission.id}`;
          }
          return "N/A";
        },
        cell: function render({ row }: { row: Row<PopulatedReviewAssignment> }) {
          const submission = row.original.submissions;
          let submitterName = "N/A";
          if (submission) {
            if (submission.assignment_groups?.name) {
              submitterName = `Group: ${submission.assignment_groups.name}`;
            } else if (submission.profiles?.name) {
              submitterName = submission.profiles.name;
            } else {
              submitterName = `Submission ID: ${submission.id}`;
            }
          }
          return submitterName;
        },
        enableColumnFilter: true,
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string) => {
          const submission = row.original.submissions;
          const filterString = String(filterValue).toLowerCase();
          if (submission) {
            if (
              submission.assignment_groups?.name &&
              submission.assignment_groups.name.toLowerCase().includes(filterString)
            )
              return true;
            if (submission.profiles?.name && submission.profiles.name.toLowerCase().includes(filterString)) return true;
            if (String(submission.id).toLowerCase().includes(filterString)) return true;
          }
          return false;
        }
      },
      {
        id: "rubric",
        header: "Rubric",
        accessorFn: (row: PopulatedReviewAssignment) => row.rubrics?.name || "N/A",
        cell: function render({ row }: { row: Row<PopulatedReviewAssignment> }) {
          return row.original.rubrics?.name || "N/A";
        },
        enableColumnFilter: true,
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string) => {
          const rubricName = row.original.rubrics?.name;
          const filterString = String(filterValue).toLowerCase();
          if (rubricName && rubricName.toLowerCase().includes(filterString)) return true;
          return String(row.original.rubric_id).toLowerCase().includes(filterString);
        }
      },
      {
        id: "due_date",
        header: `Due Date (${course.classes.time_zone ?? "America/New_York"})`,
        accessorKey: "due_date",
        cell: function render({ getValue }) {
          const dueDate = getValue<string>();
          return dueDate ? format(new TZDate(dueDate, course.classes.time_zone ?? "America/New_York"), "P p") : "N/A"; // Added time with 'p'
        }
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row: PopulatedReviewAssignment) => getReviewStatus(row),
        cell: function render({ row }: { row: Row<PopulatedReviewAssignment> }) {
          return getReviewStatus(row.original);
        },
        enableColumnFilter: true,
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string) => {
          const status = getReviewStatus(row.original);
          const filterString = String(filterValue).toLowerCase();
          return status.toLowerCase().includes(filterString);
        }
      },
      {
        id: "actions",
        header: "Actions",
        accessorKey: "id",
        enableSorting: false,
        enableColumnFilter: false,
        cell: function render({ row }) {
          return (
            <HStack gap={1} justifyContent="center">
              <IconButton
                aria-label="Edit review assignment"
                onClick={() => {
                  openAssignModal(row.original);
                }}
                variant="ghost"
                size="sm"
              >
                <FaEdit />
              </IconButton>
              <PopConfirm
                triggerLabel="Delete review assignment"
                confirmHeader="Delete Review Assignment"
                confirmText="Are you sure you want to delete this review assignment?"
                onConfirm={() => handleDelete(row.original.id)}
                onCancel={() => {}}
                trigger={
                  <IconButton aria-label="Delete review assignment" colorPalette="red" variant="ghost" size="sm">
                    <FaTrash />
                  </IconButton>
                }
              />
            </HStack>
          );
        }
      }
    ],
    [handleDelete, openAssignModal, getReviewStatus]
  );

  const table = useTable<PopulatedReviewAssignment>({
    columns,
    initialState: {
      columnFilters:
        assignmentId && !isNaN(Number(assignmentId))
          ? [{ id: "assignment_id_filter_col", value: Number(assignmentId) }]
          : [],
      pagination: {
        pageIndex: 0,
        pageSize: 50
      }
    },
    refineCoreProps: {
      resource: "review_assignments",
      filters: {
        mode: "off" // Handled by column filters or initial state
      },
      sorters: {
        mode: "off" // Client-side sorting
      },
      pagination: {
        mode: "off" // Client-side pagination
      },
      meta: {
        select:
          "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews!submission_reviews_submission_id_fkey(completed_at, grader, rubric_id, submission_id)), review_assignment_rubric_parts(*)"
      }
    },
    manualFiltering: false, // Using table's filterFns
    manualPagination: false, // Using table's pagination
    manualSorting: false, // Using table's sorting
    filterFromLeafRows: true
  });

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
    getPageCount,
    refineCore: { tableQuery }
  } = table;

  const { isLoading: isLoadingReviewAssignments, isError, error } = tableQuery;

  if (isLoadingReviewAssignments) {
    return <Spinner />;
  }

  if (isError) {
    return <Text color="red.500">Error loading reviews: {error?.message}</Text>;
  }

  const currentRows = getRowModel().rows;

  return (
    <VStack align="stretch" w="100%">
      <Table.Root>
        <Table.Header>
          {getHeaderGroups().map((headerGroup) => (
            <Table.Row bg="bg.subtle" key={headerGroup.id}>
              {headerGroup.headers
                .filter((h) => h.id !== "assignment_id_filter_col")
                .map((header) => (
                  <Table.ColumnHeader key={header.id}>
                    {header.isPlaceholder ? null : (
                      <>
                        <Text
                          onClick={header.column.getToggleSortingHandler()}
                          cursor={header.column.getCanSort() ? "pointer" : "default"}
                          textAlign={header.column.id === "actions" ? "center" : undefined}
                          title={header.column.getCanSort() ? `Sort by ${header.column.id}` : undefined}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {{
                            asc: " 🔼",
                            desc: " 🔽"
                          }[header.column.getIsSorted() as string] ?? null}
                        </Text>
                        {header.column.getCanFilter() ? (
                          <Input
                            mt={1}
                            size="sm"
                            placeholder={`Filter ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}`}
                            value={(header.column.getFilterValue() as string) ?? ""}
                            onChange={(e) => header.column.setFilterValue(e.target.value)}
                            aria-label={`Filter by ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}`}
                          />
                        ) : null}
                      </>
                    )}
                  </Table.ColumnHeader>
                ))}
            </Table.Row>
          ))}
        </Table.Header>
        <Table.Body>
          {currentRows.map((row) => (
            <Table.Row key={row.id}>
              {row
                .getVisibleCells()
                .filter((cell) => cell.column.id !== "assignment_id_filter_col")
                .map((cell) => (
                  <Table.Cell key={cell.id} textAlign={cell.column.id === "actions" ? "center" : undefined}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </Table.Cell>
                ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
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
          <Button size="sm" onClick={() => setPageIndex(getPageCount() - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
        </HStack>

        <HStack gap={2} alignItems="center">
          <Text whiteSpace="nowrap">
            Page{" "}
            <strong>
              {getState().pagination.pageIndex + 1} of {getPageCount()}
            </strong>
          </Text>
          <Text whiteSpace="nowrap">| Go to page:</Text>
          <Input
            type="number"
            defaultValue={getState().pagination.pageIndex + 1}
            min={1}
            max={getPageCount() || 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              const newPageIndex = Math.max(0, Math.min(page, getPageCount() > 0 ? getPageCount() - 1 : 0));
              setPageIndex(newPageIndex);
            }}
            width="60px"
            size="sm"
            textAlign="center"
            aria-label="Go to page number"
          />
        </HStack>
        <NativeSelect.Root
          title="Select number of reviews to display per page"
          aria-label="Select page size to show"
          width="120px"
          size="sm"
        >
          <NativeSelect.Field
            id={`page-size-select-reviews`}
            title="Select page size"
            aria-label="Select number of items per page"
            value={getState().pagination.pageSize}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setPageSize(Number(e.target.value));
            }}
          >
            {[10, 20, 30, 40, 50, 100].map((pageSizeOption) => (
              <option key={pageSizeOption} value={pageSizeOption}>
                Show {pageSizeOption}
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
      </HStack>
    </VStack>
  );
}
