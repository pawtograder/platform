"use client";

import { Button } from "@/components/ui/button";
import PersonName from "@/components/ui/person-name";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useRubrics } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { EmptyState, HStack, IconButton, Input, NativeSelect, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useDelete } from "@refinedev/core";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { ColumnDef, flexRender, Row } from "@tanstack/react-table";
import { MultiValue, Select } from "chakra-react-select";
import { format } from "date-fns";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaDownload, FaEdit, FaTrash } from "react-icons/fa";
import { MdOutlineAssignment } from "react-icons/md";

// Type definitions
export type PopulatedReviewAssignment = GetResult<
  Database["public"],
  Database["public"]["Tables"]["review_assignments"]["Row"],
  "review_assignments",
  Database["public"]["Tables"]["review_assignments"]["Relationships"],
  "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews!submission_reviews_submission_id_fkey(completed_at, grader, rubric_id, submission_id)), review_assignment_rubric_parts(*, rubric_parts!review_assignment_rubric_parts_rubric_part_id_fkey(id, name))"
>;

interface ReviewsTableProps {
  assignmentId: string | number;
  openAssignModal: (data: PopulatedReviewAssignment | null) => void;
  onReviewAssignmentDeleted: () => void;
}

// Option type for select dropdowns
interface SelectOption {
  value: string;
  label: string;
}

// Helper function to make strings safe for CSV export
function csvSafe(value: unknown): string {
  let s = String(value ?? "");
  // Neutralize potential CSV formula injection
  if (/^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  // Escape embedded quotes by doubling them per RFC 4180, wrap in quotes
  s = s.replace(/"/g, '""');
  return `"${s}"`;
}

export default function ReviewsTable({ assignmentId, openAssignModal, onReviewAssignmentDeleted }: ReviewsTableProps) {
  const { mutate: deleteReviewAssignment } = useDelete();
  const { role: course } = useClassProfiles();
  const { classRealTimeController, userRolesWithProfiles, assignmentDueDateExceptions } = useCourseController();
  const rubrics = useRubrics();
  const selfReviewRubric = rubrics?.find((r) => r.review_round === "self-review");
  const supabase = createClient();
  const [isExporting, setIsExporting] = useState(false);

  const handleDelete = useCallback(
    async (id: number) => {
      await deleteReviewAssignment(
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
    // Check if the review assignment itself is completed
    if (ra.completed_at) {
      return "Completed";
    }

    // Check if there's a matching submission review that's completed
    if (ra.submissions?.submission_reviews) {
      const matchingReview = ra.submissions.submission_reviews.find(
        (sr) =>
          sr.submission_id === ra.submission_id && sr.grader === ra.assignee_profile_id && sr.rubric_id === ra.rubric_id
      );

      if (matchingReview?.completed_at) {
        return "Completed";
      }

      if (matchingReview) {
        if (ra.due_date && new Date(ra.due_date) < new Date()) {
          return "Late";
        }
        return "In Progress";
      }
    }

    // If past due date, mark as late
    if (ra.due_date && new Date(ra.due_date) < new Date()) {
      return "Late";
    }

    return "Pending";
  }, []);

  // CSV Export function
  const exportToCSV = useCallback(async () => {
    setIsExporting(true);
    try {
      // Fetch all review assignments data
      let csvData: PopulatedReviewAssignment[];
      try {
        //Use existing TableController logic that can fetch all pages, making sure to clean up afterwards
        // Only select fields actually used in the CSV export
        const joinData = `id, assignee_profile_id, assignment_id, rubric_id, submission_id, due_date, completed_at,
              profiles!assignee_profile_id(name),
              rubrics(name),
              submissions(id, profile_id, assignment_group_id,
                profiles!profile_id(name),
                assignment_groups(name,
                  assignment_groups_members(profile_id,
                    profiles!profile_id(name)
                  )
                ),
                submission_reviews!submission_reviews_submission_id_fkey(completed_at, grader, rubric_id, submission_id)
              ),
              review_assignment_rubric_parts(review_assignment_id, rubric_part_id,
                rubric_parts!review_assignment_rubric_parts_rubric_part_id_fkey(name)
              )`;
        const tableController = new TableController<"review_assignments", typeof joinData, number>({
          client: supabase,
          table: "review_assignments",
          query: supabase
            .from("review_assignments")
            .select(joinData)
            .eq("assignment_id", Number(assignmentId))
            .not("rubric_id", "eq", selfReviewRubric?.id || 0)
            .order("id", { ascending: true })
        });
        await tableController.readyPromise;
        // Type assertion is safe here - we've selected all fields used in CSV export
        csvData = tableController.rows as unknown as PopulatedReviewAssignment[];
        tableController.close();
      } catch (error: unknown) {
        const description = error instanceof Error ? error.message : "Unknown error";
        toaster.error({ title: "Error fetching data for export", description });
        return;
      }

      if (csvData.length === 0) {
        toaster.error({ title: "No data to export" });
        return;
      }

      // Get user emails for assignees and submission authors
      const profileIds = new Set<string>();

      // Collect all profile IDs we need emails for
      csvData.forEach((ra) => {
        profileIds.add(ra.assignee_profile_id);
        if (ra.submissions?.profile_id) {
          profileIds.add(ra.submissions.profile_id);
        }
        if (ra.submissions?.assignment_groups?.assignment_groups_members) {
          ra.submissions.assignment_groups.assignment_groups_members.forEach((member) => {
            if (member.profile_id) {
              profileIds.add(member.profile_id);
            }
          });
        }
      });

      // Fetch all user emails
      const emailData = userRolesWithProfiles.rows;

      // Create email lookup map
      const emailMap = new Map<string, string>();
      emailData?.forEach((item) => {
        if (item.private_profile_id && item.users && "email" in item.users && typeof item.users.email === "string") {
          emailMap.set(item.private_profile_id, item.users.email);
        }
      });

      // Create extension lookup map
      const extensionMap = new Map<
        string,
        Array<{
          id: number;
          student_id: string | null;
          assignment_group_id: number | null;
          hours: number;
          tokens_consumed: number;
          minutes: number;
          note: string | null;
        }>
      >();
      assignmentDueDateExceptions.rows
        ?.filter((ext) => ext.assignment_id === Number(assignmentId))
        .forEach((ext) => {
          const key = ext.student_id || ext.assignment_group_id?.toString();
          if (key) {
            if (!extensionMap.has(key)) {
              extensionMap.set(key, []);
            }
            extensionMap.get(key)!.push(ext);
          }
        });

      // Generate CSV rows
      const csvRows = csvData.map((ra) => {
        const assigneeEmail = emailMap.get(ra.assignee_profile_id) || "N/A";

        // Get student emails and names
        let studentEmails: string[] = [];
        let studentNames: string[] = [];

        if (ra.submissions?.assignment_groups?.assignment_groups_members) {
          // Group submission - get all member emails and names
          studentEmails = ra.submissions.assignment_groups.assignment_groups_members
            .map((member) => emailMap.get(member.profile_id))
            .filter((email): email is string => Boolean(email));

          studentNames = ra.submissions.assignment_groups.assignment_groups_members
            .map((member) => member.profiles?.name || member.profile_id)
            .filter(Boolean);
        } else if (ra.submissions?.profile_id) {
          // Individual submission
          const email = emailMap.get(ra.submissions.profile_id);
          if (email) studentEmails = [email];

          const name = ra.submissions.profiles?.name || ra.submissions.profile_id;
          if (name) studentNames = [name];
        }

        // Get extension info
        let extensionInfo = "None";
        const submissionProfile = ra.submissions?.profile_id;
        const submissionGroup = ra.submissions?.assignment_group_id;

        const extensions = [
          ...(submissionProfile ? extensionMap.get(submissionProfile) || [] : []),
          ...(submissionGroup ? extensionMap.get(submissionGroup.toString()) || [] : [])
        ];

        if (extensions.length > 0) {
          const totalHours = extensions.reduce((sum, ext) => sum + (ext.hours || 0), 0);
          const totalTokens = extensions.reduce((sum, ext) => sum + (ext.tokens_consumed || 0), 0);
          const totalMinutes = extensions.reduce((sum, ext) => sum + (ext.minutes || 0), 0);
          const notes = extensions.map((ext) => ext.note).filter(Boolean);

          extensionInfo = `${totalHours}h ${totalMinutes}m, ${totalTokens} tokens`;
          if (notes.length > 0) {
            extensionInfo += ` (${notes.join("; ")})`;
          }
        }

        return {
          assignee: ra.profiles?.name || ra.assignee_profile_id,
          assignee_email: assigneeEmail,
          submission: ra.submissions
            ? ra.submissions.assignment_groups?.name
              ? `Group: ${ra.submissions.assignment_groups.name}`
              : ra.submissions.profiles?.name || `Submission ID: ${ra.submissions.id}`
            : "N/A",
          student_names: studentNames.join(", ") || "N/A",
          student_emails: studentEmails.join(", ") || "N/A",
          rubric: ra.rubrics?.name || "N/A",
          due_date: ra.due_date
            ? format(new TZDate(ra.due_date, course.classes.time_zone ?? "America/New_York"), "P p")
            : "N/A",
          status: getReviewStatus(ra),
          rubric_part:
            ra.review_assignment_rubric_parts
              ?.reduce((past: string, part) => {
                return past + part.rubric_parts.name + " ";
              }, "")
              ?.trim() || "All",
          extensions: extensionInfo
        };
      });

      // Convert to CSV
      if (csvRows.length === 0) {
        toaster.error({ title: "No data to export" });
        return;
      }

      const headers = [
        "Assignee",
        "Assignee Email",
        "Submission (Student/Group)",
        "Student Names",
        "Student Email(s)",
        "Rubric",
        "Due Date",
        "Status",
        "Rubric Part",
        "Extensions"
      ];

      const csvContent = [
        headers.join(","),
        ...csvRows.map((row) =>
          [
            csvSafe(row.assignee),
            csvSafe(row.assignee_email),
            csvSafe(row.submission),
            csvSafe(row.student_names),
            csvSafe(row.student_emails),
            csvSafe(row.rubric),
            csvSafe(row.due_date),
            csvSafe(row.status),
            csvSafe(row.rubric_part),
            csvSafe(row.extensions)
          ].join(",")
        )
      ].join("\n");

      // Download CSV
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", `review-assignments-${assignmentId}.csv`);
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toaster.success({ title: "CSV exported successfully" });
    } catch {
      toaster.error({ title: "Error exporting CSV", description: "An unexpected error occurred" });
    } finally {
      setIsExporting(false);
    }
  }, [
    assignmentId,
    supabase,
    selfReviewRubric,
    getReviewStatus,
    course.classes.time_zone,
    userRolesWithProfiles,
    assignmentDueDateExceptions
  ]);

  // Helper function to create filter options from unique values
  const createFilterOptions = useCallback(
    (data: PopulatedReviewAssignment[], accessor: (row: PopulatedReviewAssignment) => string): SelectOption[] => {
      const uniqueValues = Array.from(new Set(data.map(accessor).filter(Boolean)));
      return uniqueValues.map((value) => ({ value, label: value }));
    },
    []
  );

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
            <PersonName uid={row.original.assignee_profile_id} showAvatar={false} />
          ) : (
            row.original.assignee_profile_id
          );
        },
        enableColumnFilter: true,
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const assigneeName = row.original.profiles?.name || row.original.assignee_profile_id;
          return filterValue.includes(assigneeName);
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
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const submission = row.original.submissions;
          if (submission) {
            let submitterName = "N/A";
            if (submission.assignment_groups?.name) {
              submitterName = `Group: ${submission.assignment_groups.name}`;
            } else if (submission.profiles?.name) {
              submitterName = submission.profiles.name;
            } else {
              submitterName = `Submission ID: ${submission.id}`;
            }
            return filterValue.includes(submitterName);
          }
          return filterValue.includes("N/A");
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
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const rubricName = row.original.rubrics?.name || "N/A";
          return filterValue.includes(rubricName);
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
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const status = getReviewStatus(row.original);
          return filterValue.includes(status);
        }
      },
      {
        id: "rubric-part",
        header: "Rubric Part",
        accessorFn: (row: PopulatedReviewAssignment) =>
          row.review_assignment_rubric_parts?.reduce((past: string, part) => {
            return past + part.rubric_parts.name + " ";
          }, "") ?? "All",
        cell: function render({ row }: { row: Row<PopulatedReviewAssignment> }) {
          return (
            <Text>
              {row.original.review_assignment_rubric_parts?.reduce((past: string, part) => {
                return past + part.rubric_parts.name + " ";
              }, "") ?? "All"}
            </Text>
          );
        },
        enableColumnFilter: true,
        filterFn: (row: Row<PopulatedReviewAssignment>, id, filterValue: string[]) => {
          if (!filterValue || filterValue.length === 0) return true;
          const text =
            row.original.review_assignment_rubric_parts?.reduce((past: string, part) => {
              return past + part.rubric_parts.name + " ";
            }, "") ?? "All";
          return filterValue.includes(text.trim() || "All");
        }
      },
      {
        id: "actions",
        header: "Actions",
        accessorKey: "id",
        enableSorting: false,
        enableColumnFilter: false,
        cell: function render({ row }: { row: Row<PopulatedReviewAssignment> }) {
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
                onConfirm={async () => await handleDelete(row.original.id)}
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
    [handleDelete, openAssignModal, getReviewStatus, course.classes.time_zone]
  );
  const joinedSelect =
    "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews!submission_reviews_submission_id_fkey(completed_at, grader, rubric_id, submission_id)), review_assignment_rubric_parts(*, rubric_parts!review_assignment_rubric_parts_rubric_part_id_fkey(id, name))";
  const [tableController, setTableController] =
    useState<TableController<"review_assignments", typeof joinedSelect, number>>();
  useEffect(() => {
    if (!classRealTimeController) return;

    const query = supabase
      .from("review_assignments")
      .select(joinedSelect)
      .eq("assignment_id", Number(assignmentId))
      .not("rubric_id", "eq", selfReviewRubric?.id || 0);

    const tc = new TableController<"review_assignments", typeof joinedSelect, number>({
      query,
      client: supabase,
      table: "review_assignments",
      classRealTimeController,
      selectForSingleRow: joinedSelect,
      debounceInterval: 1000
    });
    setTableController(tc);
    return () => {
      tc.close();
    };
  }, [classRealTimeController, supabase, assignmentId, selfReviewRubric]);

  const table = useTableControllerTable<
    "review_assignments",
    "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews!submission_reviews_submission_id_fkey(completed_at, grader, rubric_id, submission_id)), review_assignment_rubric_parts(*, rubric_parts!review_assignment_rubric_parts_rubric_part_id_fkey(id, name))"
  >({
    columns,
    tableController,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 100
      }
    }
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
    data,
    isLoading: isLoadingReviewAssignments,
    error
  } = table;

  const isError = !!error;

  // Keep table in sync when related tables change in realtime
  useEffect(() => {
    if (!classRealTimeController || !tableController) return;
    
    let isEffectActive = true;
    let debouncedRefetchTimeout: ReturnType<typeof setTimeout> | null = null;
    
    const debouncedRefetch = () => {
      if (debouncedRefetchTimeout) {
        return;
      }
      debouncedRefetchTimeout = setTimeout(() => {
        debouncedRefetchTimeout = null;
        if (isEffectActive && tableController) {
          void tableController.refetchAll();
        }
      }, 1000);
    };
    // When a submission_review changes, invalidate the matching review_assignment row (or refetch all as fallback)
    const unsubscribeSubmissionReviews = classRealTimeController.subscribeToTable("submission_reviews", (message) => {
      try {
        // Attempt targeted invalidation when we have enough data
        const data = message.data as { submission_id?: number; grader?: string; rubric_id?: number } | undefined;
        if (data && data.submission_id && data.grader && data.rubric_id) {
          const current = tableController.list().data as unknown as PopulatedReviewAssignment[];
          const match = current.find(
            (ra) =>
              ra.submission_id === data.submission_id &&
              ra.assignee_profile_id === data.grader &&
              ra.rubric_id === data.rubric_id
          );
          if (match?.id) {
            void tableController.invalidate(match.id);
            return;
          }
        }
        // Fallback to a lightweight full refresh
        debouncedRefetch();
      } catch {
        debouncedRefetch();
      }
    });

    // If rubric parts for a review assignment change, invalidate that review assignment row
    const unsubscribeReviewAssignmentRubricParts = classRealTimeController.subscribeToTable(
      "review_assignment_rubric_parts",
      (message) => {
        const data = message.data as { review_assignment_id?: number } | undefined;
        if (data?.review_assignment_id) {
          void tableController.invalidate(data.review_assignment_id as number);
        } else {
          debouncedRefetch();
        }
      }
    );

    // Keep in sync with direct changes to review_assignments
    const unsubscribeReviewAssignments = classRealTimeController.subscribeToTable("review_assignments", (message) => {
      try {
        if (message.operation === "INSERT" || message.operation === "UPDATE" || message.operation === "DELETE") {
          const assignmentIdNum = Number(assignmentId);
          const mData = message.data as { id?: number; assignment_id?: number } | undefined;
          if (mData?.assignment_id === assignmentIdNum && typeof mData.id === "number") {
            void tableController.invalidate(mData.id as number);
          } else if (typeof message.row_id === "number") {
            void tableController.invalidate(message.row_id as number);
          } else {
            debouncedRefetch();
          }
        }
      } catch {
        debouncedRefetch();
      }
    });

    return () => {
      isEffectActive = false;
      if (debouncedRefetchTimeout) {
        clearTimeout(debouncedRefetchTimeout);
      }
      unsubscribeSubmissionReviews();
      unsubscribeReviewAssignmentRubricParts();
      unsubscribeReviewAssignments();
    };
  }, [classRealTimeController, tableController, assignmentId]);

  // Generate filter options from data
  const filterOptions = useMemo(() => {
    if (!data || data.length === 0) return {};

    return {
      assignee: createFilterOptions(data, (row) => row.profiles?.name || row.assignee_profile_id),
      submission: createFilterOptions(data, (row) => {
        const submission = row.submissions;
        if (submission) {
          if (submission.assignment_groups?.name) return `Group: ${submission.assignment_groups.name}`;
          if (submission.profiles?.name) return submission.profiles.name;
          return `Submission ID: ${submission.id}`;
        }
        return "N/A";
      }),
      rubric: createFilterOptions(data, (row) => row.rubrics?.name || "N/A"),
      status: createFilterOptions(data, (row) => getReviewStatus(row)),
      "rubric-part": createFilterOptions(
        data,
        (row) =>
          row.review_assignment_rubric_parts
            ?.reduce((past: string, part) => {
              return past + part.rubric_parts.name + " ";
            }, "")
            ?.trim() ?? "All"
      )
    };
  }, [data, createFilterOptions, getReviewStatus]);

  if (isLoadingReviewAssignments) {
    return <Spinner />;
  }

  if (isError) {
    return <Text color="red.500">Error loading reviews: {error?.message}</Text>;
  }

  const currentRows = getRowModel().rows;

  return (
    <VStack align="stretch" w="100%">
      <HStack justifyContent="space-between" alignItems="center" mb={4}>
        <Text fontSize="lg" fontWeight="bold">
          Review Assignments
        </Text>
        <Button onClick={exportToCSV} size="sm" variant="outline" loading={isExporting}>
          <FaDownload style={{ marginRight: "8px" }} />
          Export CSV
        </Button>
      </HStack>
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
                          <Select
                            isMulti
                            size="sm"
                            placeholder={`Filter ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}`}
                            options={filterOptions[header.column.id as keyof typeof filterOptions] || []}
                            value={((header.column.getFilterValue() as string[]) || []).map((val) => ({
                              value: val,
                              label: val
                            }))}
                            onChange={(selectedOptions: MultiValue<SelectOption>) => {
                              const values = selectedOptions.map((option) => option.value);
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            aria-label={`Filter by ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}`}
                            chakraStyles={{
                              container: (provided) => ({
                                ...provided,
                                marginTop: "4px"
                              })
                            }}
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
      {currentRows.length === 0 && (
        <EmptyState.Root size={"md"}>
          <EmptyState.Content>
            <EmptyState.Indicator>
              <MdOutlineAssignment />
            </EmptyState.Indicator>
            <VStack textAlign="center">
              <EmptyState.Title>No review assignments</EmptyState.Title>
              <EmptyState.Description>There aren&apos;t any reviews for this assignment yet</EmptyState.Description>
            </VStack>
          </EmptyState.Content>
        </EmptyState.Root>
      )}
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
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
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
            {[10, 20, 30, 40, 50, 100, 1000].map((pageSizeOption) => (
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
