"use client";
import Link from "@/components/ui/link";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import { rerunGrader } from "@/lib/edgeFunctions";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  ActiveSubmissionsWithRegressionTestResults,
  Assignment,
  Autograder,
  AutograderCommit
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  Checkbox,
  Code,
  Heading,
  HStack,
  Icon,
  List,
  Skeleton,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useList, useOne } from "@refinedev/core";
import * as Sentry from "@sentry/nextjs";
import { CellContext, ColumnDef, flexRender } from "@tanstack/react-table";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { FaSort, FaSortDown, FaSortUp } from "react-icons/fa";
import { Select as ReactSelect } from "chakra-react-select";

interface SelectOption {
  label: string;
  value: string;
}

function SubmissionGraderTable({ autograder_repo }: { autograder_repo: string }) {
  const { assignment_id, course_id } = useParams();
  const { role } = useClassProfiles();
  const course = role.classes;
  const timeZone = course.time_zone || "America/New_York";
  const renderAsLinkToSubmission = useCallback(
    (props: CellContext<ActiveSubmissionsWithRegressionTestResults, unknown>) => {
      const row = props.row;
      const value = props.getValue();
      if (value === null || value === undefined) {
        return <Text></Text>;
      }
      if (row.original.activesubmissionid === null) {
        return <Text>{value as string}</Text>;
      }
      return (
        <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`}>
          <Text onClick={(e) => e.stopPropagation()}>{value as string}</Text>
        </Link>
      );
    },
    [course_id, assignment_id]
  );
  const columns = useMemo<ColumnDef<ActiveSubmissionsWithRegressionTestResults>[]>(
    () => [
      {
        id: "assignment_id",
        accessorKey: "assignment_id",
        header: "Assignment",
        filterFn: (row, id, filterValue) => {
          return String(row.original.assignment_id) === String(filterValue);
        }
      },
      {
        id: "activesubmissionid",
        accessorKey: "activesubmissionid",
        header: "Active Submission ID",
        cell: renderAsLinkToSubmission
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Student",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!row.original.name) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => row.original.name?.toLowerCase().includes(filter.toLowerCase()));
        },
        cell: renderAsLinkToSubmission
      },
      {
        id: "groupname",
        accessorKey: "groupname",
        header: "Group",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!row.original.groupname) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            row.original.groupname?.toLowerCase().includes(filter.toLowerCase())
          );
        },
        cell: renderAsLinkToSubmission
      },
      {
        id: "autograder_score",
        accessorKey: "autograder_score",
        header: "Autograder Score",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (row.original.autograder_score === null || row.original.autograder_score === undefined) return false;
          if (
            filterValue === undefined ||
            filterValue === null ||
            (Array.isArray(filterValue) && filterValue.length === 0)
          )
            return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => String(row.original.autograder_score) === filter);
        },
        cell: renderAsLinkToSubmission
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Submission Date",
        enableColumnFilter: true,
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }
          return <Text>{new TZDate(props.getValue() as string, timeZone).toLocaleString()}</Text>;
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.created_at) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const date = new TZDate(row.original.created_at, timeZone);
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            date.toLocaleString().toLowerCase().includes(filter.toLowerCase())
          );
        }
      },
      {
        id: "rerun_queued_at",
        accessorKey: "rerun_queued_at",
        header: "Rerun Status",
        enableColumnFilter: true,
        cell: (props) => {
          const queuedAt = props.getValue() as string | null;
          if (!queuedAt) {
            return <Text color="fg.muted">—</Text>;
          }
          return (
            <VStack gap={0} align="start">
              <Text color="orange.600" fontWeight="medium">
                Requested
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {new TZDate(queuedAt, timeZone).toLocaleString()}
              </Text>
            </VStack>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          const hasPending = row.original.rerun_queued_at !== null;
          return filterArray.some((filter: string) => {
            if (filter === "Pending") return hasPending;
            if (filter === "None") return !hasPending;
            return false;
          });
        }
      },
      {
        id: "grader_sha",
        accessorKey: "grader_sha",
        header: "Submission Autograder SHA",
        enableColumnFilter: true,
        cell: (props) => {
          if (!props.getValue()) {
            return <Text></Text>;
          }
          return (
            <Link href={`https://github.com/${autograder_repo}/commit/${props.getValue()}`} target="_blank">
              <Code onClick={(e) => e.stopPropagation()}>{(props.getValue() as string).slice(0, 7)}</Code>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.grader_sha) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            (row.original.grader_sha as string).toLowerCase().includes(filter.toLowerCase())
          );
        }
      },
      {
        id: "rt_autograder_score",
        accessorKey: "rt_autograder_score",
        header: "Development Autograder Score (Hidden)",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (row.original.rt_autograder_score === null || row.original.rt_autograder_score === undefined) return false;
          if (
            filterValue === undefined ||
            filterValue === null ||
            (Array.isArray(filterValue) && filterValue.length === 0)
          )
            return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => String(row.original.rt_autograder_score) === filter);
        }
      },
      {
        id: "rt_grader_sha",
        accessorKey: "rt_grader_sha",
        header: "Development Autograder SHA (Hidden)",
        enableColumnFilter: true,
        cell: (props) => {
          if (!props.getValue()) {
            return <Text></Text>;
          }
          return (
            <Link href={`https://github.com/${autograder_repo}/commit/${props.getValue()}`} target="_blank">
              <Code onClick={(e) => e.stopPropagation()}>{(props.getValue() as string).slice(0, 7)}</Code>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.rt_grader_sha) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            (row.original.rt_grader_sha as string).toLowerCase().includes(filter.toLowerCase())
          );
        }
      }
    ],
    [timeZone, autograder_repo, renderAsLinkToSubmission]
  );

  const supabase = useMemo(() => createClient(), []);
  const { classRealTimeController } = useCourseController();
  const tableController = useMemo(() => {
    Sentry.addBreadcrumb({
      category: "tableController",
      message: "Fetching submissions_with_grades_for_assignment_and_regression_test",
      level: "info"
    });
    const query = supabase
      .from("submissions_with_grades_for_assignment_and_regression_test")
      .select("*")
      .eq("assignment_id", Number(assignment_id));

    return new TableController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: query as any,
      client: supabase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: "submissions_with_grades_for_assignment_and_regression_test" as any,
      classRealTimeController
    });
  }, [supabase, assignment_id, classRealTimeController]);
  const { getHeaderGroups, getRowModel, getRowCount, getCoreRowModel, data } = useTableControllerTable({
    columns,
    tableController,
    initialState: {
      sorting: [{ id: "name", desc: false }],
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      }
    }
  });
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [regrading, setRegrading] = useState<boolean>(false);

  // Compute unique values for each column from ALL rows (before filtering)
  // Depends on 'data' so it recalculates when async data loads
  const columnUniqueValues = useMemo(() => {
    const rows = getCoreRowModel().rows; // Use getCoreRowModel to get ALL rows before filtering
    const uniqueValuesMap: Record<string, SelectOption[]> = {};

    columns.forEach((column) => {
      if (!column.enableColumnFilter) return;

      if (column.id === "rerun_queued_at") {
        // Special handling for rerun status - show Pending/None options
        const hasPending = rows.some((row) => row.getValue(column.id as string) !== null);
        const hasNone = rows.some((row) => row.getValue(column.id as string) === null);
        const options: SelectOption[] = [];
        if (hasPending) options.push({ label: "Pending", value: "Pending" });
        if (hasNone) options.push({ label: "None", value: "None" });
        uniqueValuesMap[column.id as string] = options;
        return;
      }

      const uniqueValues = new Set<string>();
      rows.forEach((row) => {
        const value = row.getValue(column.id as string);
        if (value !== null && value !== undefined) {
          if (column.id === "created_at") {
            // For dates, show the formatted date string
            const dateValue = new TZDate(value as string, timeZone).toLocaleString();
            uniqueValues.add(dateValue);
          } else if (column.id === "grader_sha" || column.id === "rt_grader_sha") {
            // For SHAs, show the short version
            uniqueValues.add((value as string).slice(0, 7));
          } else {
            uniqueValues.add(String(value));
          }
        }
      });

      uniqueValuesMap[column.id as string] = Array.from(uniqueValues)
        .sort()
        .map((value) => ({ label: value, value }));
    });

    return uniqueValuesMap;
    // data is what actually changes, so we need to include it in the dependency array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, columns, timeZone, getCoreRowModel]);

  return (
    <VStack>
      <Toaster />
      <VStack paddingBottom="55px">
        <Table.Root interactive>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row bg="bg.subtle" key={headerGroup.id}>
                <Table.ColumnHeader>
                  <Checkbox.Root
                    id="select-all"
                    colorPalette="green"
                    onCheckedChange={(checked) => {
                      if (checked.checked) {
                        setSelectedRows(
                          getRowModel()
                            .rows.map((row) => row.original.activesubmissionid)
                            .filter((id) => id !== null) as number[]
                        );
                      } else {
                        setSelectedRows([]);
                      }
                    }}
                  >
                    <Checkbox.HiddenInput />
                    <VStack>
                      <Checkbox.Label>Select all</Checkbox.Label>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </VStack>
                  </Checkbox.Root>
                </Table.ColumnHeader>
                {headerGroup.headers
                  .filter((h) => h.id !== "assignment_id")
                  .map((header) => {
                    const canFilter = header.column.columnDef.enableColumnFilter;
                    const options = columnUniqueValues[header.id] || [];
                    return (
                      <Table.ColumnHeader key={header.id}>
                        {header.isPlaceholder ? null : (
                          <>
                            <Text onClick={header.column.getToggleSortingHandler()}>
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
                              <ReactSelect
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
            {getRowModel()
              .rows //.filter(row => row.getValue("profiles.name") !== undefined)
              .map((row) => {
                return (
                  <Table.Row
                    key={row.id}
                    onClick={() => {
                      if (row.original.activesubmissionid) {
                        setSelectedRows((prev) => {
                          if (row.original.activesubmissionid === null) {
                            return prev;
                          }
                          if (prev.includes(row.original.activesubmissionid)) {
                            return prev.filter((id) => id !== row.original.activesubmissionid);
                          }
                          return [...prev, row.original.activesubmissionid];
                        });
                      }
                    }}
                  >
                    <Table.Cell>
                      {row.original.activesubmissionid && (
                        <Checkbox.Root
                          id={String(row.original.activesubmissionid)}
                          colorPalette="green"
                          checked={selectedRows.includes(row.original.activesubmissionid)}
                          onCheckedChange={(checked) => {
                            const id = row.original.activesubmissionid;
                            if (id === null) {
                              return;
                            }
                            if (checked.checked) {
                              setSelectedRows((prev) => [...prev, id]);
                            } else {
                              setSelectedRows((prev) => prev.filter((id) => id !== id));
                            }
                          }}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Root>
                      )}
                    </Table.Cell>
                    {row
                      .getVisibleCells()
                      .filter((c) => c.column.id !== "assignment_id")
                      .map((cell) => {
                        return (
                          <Table.Cell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </Table.Cell>
                        );
                      })}
                  </Table.Row>
                );
              })}
          </Table.Body>
        </Table.Root>
        <div>{getRowCount()} Rows</div>
      </VStack>
      <Box
        p="2"
        border="1px solid"
        borderColor="border.muted"
        backgroundColor="bg.subtle"
        height="55px"
        style={{
          position: "fixed",
          bottom: 0,
          right: 0,
          width: "100%"
        }}
      >
        <HStack justifyContent="flex-end">
          <Button
            colorPalette="green"
            variant="solid"
            loading={regrading}
            onClick={async () => {
              setRegrading(true);
              try {
                await rerunGrader(
                  {
                    submission_ids: selectedRows,
                    class_id: course.id
                  },
                  supabase
                );
                await tableController.refetchAll();
                toaster.success({
                  title: "Regrading started",
                  description: "This may take a while... Use the Workflow Runs page to view the complete status."
                });
              } catch (error) {
                toaster.error({
                  title: "Error regrading",
                  description: error instanceof Error ? error.message : "Unknown error"
                });
              } finally {
                setRegrading(false);
              }
            }}
          >
            Regrade selected
          </Button>
        </HStack>
      </Box>
    </VStack>
  );
}
type AssignmentWithAutograder = Assignment & { autograder: Autograder };
export default function RerunAutograderPage() {
  const { assignment_id, course_id } = useParams();
  const { data: assignment, isLoading: isAssignmentLoading } = useOne<AssignmentWithAutograder>({
    resource: "assignments",
    id: assignment_id as string,
    meta: {
      select: "*, autograder(*)"
    }
  });
  const { isLoading: isAutograderCommitsLoading } = useList<AutograderCommit>({
    resource: "autograder_commits",
    meta: {
      select: "*"
    },
    liveMode: "auto",
    filters: [
      {
        field: "autograder_id",
        operator: "eq",
        value: assignment_id as string
      }
    ]
  });
  if (isAssignmentLoading || isAutograderCommitsLoading) {
    return <Skeleton height="100px" />;
  }
  if (!assignment?.data.autograder.grader_repo) {
    return <Text>Assignment not found</Text>;
  }
  return (
    <Box>
      <Heading size="md">Rerun Autograder</Heading>
      <Text fontSize="sm" color="fg.muted">
        This table will allow you to rerun the autograder (potentially using a newer version) on the currently active
        submissions for students, overriding any due dates. Note that doing so will create a NEW submission for each
        student.
      </Text>
      <Text fontSize="sm" color="fg.muted">
        Re-running the autograder can be a time-consuming process, and it will occur asynchronously. After you select
        &quot;Regrade selected&quot;, the rows will be updated to show that a re-run was requested. Once it has been
        received by GitHub, it will no longer show as &quot;Requested&quot; here, but you will be able to see the queued
        workflow runs begin to appear in the{" "}
        <Link href={`/course/${course_id}/manage/workflow-runs`}>Workflow Runs Table</Link>.
      </Text>
      <Box fontSize="sm" border="1px solid" borderColor="border.info" borderRadius="md" p={4}>
        <Heading size="sm">How to debug and rerun the autograder</Heading>
        Student submissions are automatically graded using the most recent revision of the autograder
        <Code>main</Code> branch. If you need to edit the autograder, you should:
        <List.Root as="ol" px={8} py={4}>
          <List.Item>
            Use the <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/autograder`}>Autograder</Link>{" "}
            tab to select several student submissions to use for testing.
          </List.Item>
          <List.Item>
            Make the changes to the autograder, pushing them to a{" "}
            <Text as="span" color="fg.accent" fontWeight="bold">
              different
            </Text>{" "}
            branch than <Code>main</Code> (choose a good name).
          </List.Item>
          <List.Item>
            Check the detailed output of running the autograder on those test submissions by viewing the GitHub Actions
            logs for your new commit.
          </List.Item>
          <List.Item>Refresh and check this table to compare the new autograder scores to the old one.</List.Item>
          <List.Item>
            If satisfied, merge your new branch into <Code>main</Code>.
          </List.Item>
          <List.Item>
            Use this page to re-run some (or all) of the student submissions using the new autograder.
          </List.Item>
        </List.Root>
        (If you want to be wild, skip the branching and just edit <Code>main</Code>, but you risk new student
        submissions getting graded with a potentially buggy version of the autograder that you are still testing.)
      </Box>
      <Box>
        The current autograder commit to <Code>main</Code> is{" "}
        <Code>{assignment.data.autograder.latest_autograder_sha?.slice(0, 7)}</Code>.
      </Box>

      <SubmissionGraderTable autograder_repo={assignment?.data.autograder.grader_repo} />
    </Box>
  );
}
