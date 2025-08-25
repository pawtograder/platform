"use client";

import { Box, Heading, Text, HStack, Button, Link, Spinner, Input } from "@chakra-ui/react";
import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import PersonName from "@/components/ui/person-name";
import { Table } from "@chakra-ui/react";
import NextLink from "next/link";
import { flexRender, ColumnDef, CellContext } from "@tanstack/react-table";
import { useCustomTable } from "@/hooks/useCustomTable";
import { Select, CreatableSelect } from "chakra-react-select";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database } from "@/utils/supabase/SupabaseTypes";

export default function GradingErrorsPage() {
  return (
    <Box>
      <Heading as="h1" size="lg" mb={4}>
        Grading Errors
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={6}>
        Track and debug workflow errors that occur during the grading process. Monitor error patterns, identify issues
        requiring instructor attention, and ensure smooth submission processing.
      </Text>
      <WorkflowErrorsTable />
    </Box>
  );
}

type WorkflowRunErrorRow = GetResult<
  Database["public"],
  Database["public"]["Tables"]["workflow_run_error"]["Row"],
  "workflow_run_error",
  Database["public"]["Tables"]["workflow_run_error"]["Relationships"],
  `*,
        repositories!repository_id(
          id,
          repository,
          synced_handout_sha
        ),
        submissions!submission_id(
          id,
          profile_id,
          repository,
          sha,
          run_number,
          run_attempt,
          assignment_group_id,
          assignment_id,
          profiles!profile_id(
            name,
            id
          ),
          assignments!assignment_id(
            slug,
            title
          ),
          assignment_groups!assignment_group_id(
            id,
            name
          )
        )`
>;
function WorkflowErrorsTable() {
  const { course_id } = useParams();

  // Memoize server filters to prevent unnecessary API calls
  const serverFilters = useMemo(
    () => [
      {
        field: "class_id",
        operator: "eq" as const,
        value: course_id as string
      }
    ],
    [course_id]
  );

  // Memoize initial state to prevent table re-initialization
  const initialState = useMemo(
    () => ({
      pagination: {
        pageIndex: 0,
        pageSize: 25
      },
      sorting: [
        {
          id: "created_at",
          desc: true
        }
      ]
    }),
    []
  );

  const columns = useMemo<ColumnDef<WorkflowRunErrorRow>[]>(
    () => [
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "When",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunErrorRow, unknown>) => (
          <Text fontSize="sm">{formatDistanceToNow(new Date(getValue() as string), { addSuffix: true })}</Text>
        ),
        filterFn: (row, id, filterValue) => {
          const date = new Date(row.original.created_at);
          const filterString = String(filterValue).toLowerCase();
          const dateString = formatDistanceToNow(date, { addSuffix: true }).toLowerCase();
          return dateString.includes(filterString);
        }
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Error",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunErrorRow, unknown>) => (
          <Text fontSize="sm" fontWeight="medium">
            {getValue() as string}
          </Text>
        ),
        filterFn: (row, id, filterValue) => {
          const name = row.original.name;
          if (!name) return false;
          const filterString = String(filterValue).toLowerCase();
          return name.toLowerCase().includes(filterString);
        }
      },
      {
        id: "student",
        accessorKey: "submissions.profiles.name", // Add accessor for filtering
        header: "Student/Group",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowRunErrorRow, unknown>) => {
          const submission = row.original.submissions;
          if (!submission) return <Text fontSize="sm">-</Text>;

          // Show group name if this is a group assignment
          if (submission.assignment_groups && submission.assignment_groups.name) {
            return (
              <Text fontSize="sm" fontWeight="medium">
                📁 {submission.assignment_groups.name}
              </Text>
            );
          }

          // Show student name for individual submissions
          if (submission.profiles) {
            return <PersonName uid={submission.profiles.id} size="sm" showAvatar={false} />;
          }

          return <Text fontSize="sm">-</Text>;
        },
        filterFn: (row, id, filterValue) => {
          const submission = row.original.submissions;
          if (!submission) return false;

          const filterString = String(filterValue).toLowerCase();

          // Check group name
          if (submission.assignment_groups?.name) {
            return submission.assignment_groups.name.toLowerCase().includes(filterString);
          }

          // Check student name
          if (submission.profiles?.name) {
            return submission.profiles.name.toLowerCase().includes(filterString);
          }

          return false;
        }
      },
      {
        id: "repository",
        header: "Repository",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowRunErrorRow, unknown>) => {
          const error = row.original;
          const repository = error.repositories;
          const submission = error.submissions;
          const repoName = repository?.repository || submission?.repository;

          if (!repoName) return <Text fontSize="sm">-</Text>;

          const sha = submission?.sha;
          const githubUrl = sha ? `https://github.com/${repoName}/commit/${sha}` : `https://github.com/${repoName}`;

          return (
            <Link as={NextLink} href={githubUrl} target="_blank" fontSize="sm" _hover={{ textDecoration: "underline" }}>
              {repoName.split("/").pop()}
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          const error = row.original;
          const repository = error.repositories;
          const submission = error.submissions;
          const repoName = repository?.repository || submission?.repository;

          if (!repoName) return false;
          const filterString = String(filterValue).toLowerCase();
          return repoName.toLowerCase().includes(filterString);
        }
      },
      {
        id: "commit",
        header: "Commit",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowRunErrorRow, unknown>) => {
          const error = row.original;
          const submission = error.submissions;
          const sha = submission?.sha;

          if (!sha) return <Text fontSize="sm">-</Text>;

          return (
            <Text fontFamily="mono" fontSize="xs">
              {sha.substring(0, 7)}
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          const submission = row.original.submissions;
          const sha = submission?.sha;

          if (!sha) return false;
          const filterString = String(filterValue).toLowerCase();
          return sha.toLowerCase().includes(filterString);
        }
      },
      {
        id: "submission_link",
        header: "Submission",
        cell: ({ row }: CellContext<WorkflowRunErrorRow, unknown>) => {
          const submission = row.original.submissions;
          if (!submission) return <Text fontSize="sm">-</Text>;

          const submissionUrl = `/course/${course_id}/assignments/${submission.assignment_id}/submissions/${submission.id}`;

          return (
            <Link as={NextLink} href={submissionUrl} fontSize="sm" _hover={{ textDecoration: "underline" }}>
              Submission
            </Link>
          );
        }
      },
      {
        id: "workflow_run",
        header: "Actions",
        cell: ({ row }: CellContext<WorkflowRunErrorRow, unknown>) => {
          const error = row.original;
          const repository = error.repositories;
          const submission = error.submissions;

          // For now, we don't have workflow_run_id anymore, so we can't link to specific workflow runs
          // We can link to the repository's actions page instead
          const repoName = repository?.repository || submission?.repository;

          if (!repoName) {
            return <Text fontSize="sm">-</Text>;
          }

          const actionsUrl = `https://github.com/${repoName}/actions/runs/${submission?.run_number}/attempts/${submission?.run_attempt}`;

          return (
            <Link
              as={NextLink}
              href={actionsUrl}
              target="_blank"
              fontSize="sm"
              _hover={{ textDecoration: "underline" }}
            >
              CI
            </Link>
          );
        }
      },
      {
        id: "error_type",
        accessorKey: "data", // Add accessor for filtering
        header: "Type",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ row }: CellContext<WorkflowRunErrorRow, unknown>) => {
          const error = row.original;
          let errorType = "unknown";

          try {
            const data = JSON.parse(String(error.data || "{}"));
            errorType = data.type || "unknown";
          } catch {
            // Invalid JSON, keep defaults
          }

          return (
            <Text fontSize="xs" fontWeight="medium">
              {errorType.replace("_", " ")}
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          const error = row.original;
          let errorType = "unknown";

          try {
            const data = JSON.parse(String(error.data || "{}"));
            errorType = data.type || "unknown";
          } catch {
            // Invalid JSON, keep defaults
          }

          const filterString = String(filterValue).toLowerCase();
          return errorType.replace("_", " ").toLowerCase().includes(filterString);
        }
      },
      {
        id: "is_private",
        accessorKey: "is_private", // Add accessor for filtering
        header: "Visibility",
        enableColumnFilter: true,
        enableSorting: true,
        cell: ({ getValue }: CellContext<WorkflowRunErrorRow, unknown>) => (
          <Text fontSize="xs" fontWeight="medium">
            {(getValue() as boolean) ? "Private" : "Public"}
          </Text>
        ),
        filterFn: (row, id, filterValue) => {
          const isPrivate = row.original.is_private;
          const filterString = String(filterValue).toLowerCase();
          const visibilityText = isPrivate ? "private" : "public";
          return visibilityText.includes(filterString);
        }
      }
    ],
    [course_id]
  );

  const {
    getHeaderGroups,
    getRowModel,
    getRowCount,
    getState,
    setPageIndex,
    getCanPreviousPage,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    isLoading,
    error
  } = useCustomTable<WorkflowRunErrorRow>({
    columns,
    resource: "workflow_run_error",
    serverFilters,
    select: `
      *,
      repositories!repository_id(
        id,
        repository,
        synced_handout_sha
      ),
      submissions!submission_id(
        id,
        profile_id,
        repository,
        sha,
        run_number,
        run_attempt,
        assignment_group_id,
        assignment_id,
        profiles!profile_id(
          name,
          id
        ),
        assignments!assignment_id(
          slug,
          title
        ),
        assignment_groups!assignment_group_id(
          id,
          name
        )
      )
    `,
    initialState
  });

  if (isLoading) {
    return (
      <Box>
        <Box display="flex" justifyContent="center" alignItems="center" py={4}>
          <Spinner size="sm" />
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Box p={4} bg="red.50" border="1px solid" borderColor="red.200" borderRadius="md">
          <Text color="red.600">Failed to load workflow errors: {error.message}</Text>
        </Box>
      </Box>
    );
  }

  const workflowErrors = getRowModel().rows.map((row) => row.original);
  const nRows = getRowCount();
  const pageSize = getState().pagination.pageSize;
  const pageCount = Math.ceil(nRows / pageSize);

  // Extract unique values for filter options
  const uniqueErrorNames = [...new Set(workflowErrors.map((error) => error.name).filter(Boolean))].map((name) => ({
    label: name,
    value: name
  }));

  const uniqueStudentNames = [
    ...new Set(
      workflowErrors
        .map((error) => {
          const submission = error.submissions;
          if (submission?.assignment_groups?.name) {
            return `📁 ${submission.assignment_groups.name}`;
          }
          if (submission?.profiles?.name) {
            return submission.profiles.name;
          }
          return null;
        })
        .filter(Boolean)
    )
  ].map((name) => ({
    label: name,
    value: name
  }));

  const uniqueRepositories = [
    ...new Set(
      workflowErrors
        .map((error) => {
          const repository = error.repositories;
          const submission = error.submissions;
          const repoName = repository?.repository || submission?.repository;
          return repoName ? repoName.split("/").pop() : null;
        })
        .filter(Boolean)
    )
  ].map((repo) => ({
    label: repo,
    value: repo
  }));

  const uniqueCommits = [...new Set(workflowErrors.map((error) => error.submissions?.sha).filter(Boolean))].map(
    (sha) => ({
      label: sha?.substring(0, 7) || "unknown",
      value: sha
    })
  );

  return (
    <Box>
      {workflowErrors.length === 0 ? (
        <Box p={6} borderRadius="md" textAlign="center">
          <Text fontSize="lg" fontWeight="medium">
            🎉 No errors found!
          </Text>
          <Text fontSize="sm" mt={2}>
            All workflows are running smoothly.
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
                getHeaderGroups().forEach((headerGroup) => {
                  headerGroup.headers.forEach((header) => {
                    if (header.column.getCanFilter()) {
                      header.column.setFilterValue("");
                    }
                  });
                });
              }}
            >
              Clear All Filters
            </Button>
            <Text fontSize="sm" color="fg.muted">
              Showing {workflowErrors.length} of {nRows} errors
            </Text>
          </HStack>

          <Table.Root>
            <Table.Header>
              {getHeaderGroups().map((headerGroup) => (
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
                            {header.column.getCanFilter() &&
                              header.id !== "submission_link" &&
                              header.id !== "workflow_run" && (
                                <>
                                  {header.id === "created_at" && (
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
                                      placeholder="Filter by time..."
                                      size="sm"
                                    />
                                  )}
                                  {header.id === "name" && (
                                    <CreatableSelect
                                      isMulti={false}
                                      id={header.id}
                                      isClearable
                                      isSearchable
                                      onChange={(e) => {
                                        header.column.setFilterValue(e?.value || "");
                                      }}
                                      options={uniqueErrorNames}
                                      placeholder="Filter by error name..."
                                      size="sm"
                                    />
                                  )}
                                  {header.id === "student" && (
                                    <CreatableSelect
                                      isMulti={false}
                                      id={header.id}
                                      isClearable
                                      isSearchable
                                      onChange={(e) => {
                                        header.column.setFilterValue(e?.value || "");
                                      }}
                                      options={uniqueStudentNames}
                                      placeholder="Filter by student/group..."
                                      size="sm"
                                    />
                                  )}
                                  {header.id === "repository" && (
                                    <CreatableSelect
                                      isMulti={false}
                                      id={header.id}
                                      isClearable
                                      isSearchable
                                      onChange={(e) => {
                                        header.column.setFilterValue(e?.value || "");
                                      }}
                                      options={uniqueRepositories}
                                      placeholder="Filter by repository..."
                                      size="sm"
                                    />
                                  )}
                                  {header.id === "commit" && (
                                    <CreatableSelect
                                      isMulti={false}
                                      id={header.id}
                                      isClearable
                                      isSearchable
                                      onChange={(e) => {
                                        header.column.setFilterValue(e?.value || "");
                                      }}
                                      options={uniqueCommits}
                                      placeholder="Filter by commit hash..."
                                      size="sm"
                                    />
                                  )}
                                  {header.id === "is_private" && (
                                    <Select
                                      isMulti={false}
                                      id={header.id}
                                      isClearable
                                      onChange={(e) => {
                                        header.column.setFilterValue(e?.value || "");
                                      }}
                                      options={[
                                        { label: "Private", value: "private" },
                                        { label: "Public", value: "public" }
                                      ]}
                                      placeholder="Filter visibility..."
                                      size="sm"
                                    />
                                  )}
                                  {header.id === "error_type" && (
                                    <Select
                                      isMulti={false}
                                      id={header.id}
                                      isClearable
                                      onChange={(e) => {
                                        header.column.setFilterValue(e?.value || "");
                                      }}
                                      options={[
                                        { label: "User Visible Error", value: "user visible error" },
                                        { label: "Security Error", value: "security error" },
                                        { label: "Config Error", value: "config error" },
                                        { label: "Unknown", value: "unknown" }
                                      ]}
                                      placeholder="Filter error type..."
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
              {getRowModel().rows.map((row) => (
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
                size="sm"
              />
            </HStack>

            <HStack gap={2}>
              <Text fontSize="sm">Page size:</Text>
              <select
                value={getState().pagination.pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
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
