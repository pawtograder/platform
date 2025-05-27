"use client";
import Link from "@/components/ui/link";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useCourse } from "@/hooks/useAuthState";
import { rerunGrader } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import type {
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
  Input,
  List,
  NativeSelect,
  Skeleton,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useList, useOne } from "@refinedev/core";
import { useTable } from "@refinedev/react-table";
import {
  type CellContext,
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel
} from "@tanstack/react-table";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";
import { FaSort, FaSortDown, FaSortUp } from "react-icons/fa";

function SubmissionGraderTable({ autograder_repo }: { autograder_repo: string }) {
  const { assignment_id, course_id } = useParams();
  const course = useCourse();
  const timeZone = course.classes.time_zone || "America/New_York";
  const [pageCount, setPageCount] = useState(0);
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
        filterFn: (row, filterValue) => {
          return String(row.original.assignment_id) === String(filterValue);
        }
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Student",
        enableColumnFilter: true,
        filterFn: (row, filterValue) => {
          if (!row.original.name) return false;
          const filterString = String(filterValue).toLowerCase();
          return row.original.name.toLowerCase().includes(filterString);
        }
      },
      {
        id: "groupname",
        accessorKey: "groupname",
        header: "Group",
        cell: renderAsLinkToSubmission
      },
      {
        id: "autograder_score",
        accessorKey: "autograder_score",
        header: "Autograder Score",
        cell: renderAsLinkToSubmission
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Submission Date",
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }
          return <Text>{new TZDate(props.getValue() as string, timeZone).toLocaleString()}</Text>;
        },
        filterFn: (row, filterValue) => {
          if (!row.original.created_at) return false;
          const date = new TZDate(row.original.created_at, timeZone);
          const filterString = String(filterValue);
          return date.toLocaleString().toLowerCase().includes(filterString.toLowerCase());
        }
      },
      {
        id: "grader_sha",
        accessorKey: "grader_sha",
        header: "Submission Autograder SHA",
        cell: (props) => {
          if (!props.getValue()) {
            return <Text></Text>;
          }
          return (
            <Link href={`https://github.com/${autograder_repo}/commit/${props.getValue()}`} target="_blank">
              <Code onClick={(e) => e.stopPropagation()}>{(props.getValue() as string).slice(0, 7)}</Code>
            </Link>
          );
        }
      },
      {
        id: "rt_autograder_score",
        accessorKey: "rt_autograder_score",
        header: "Development Autograder Score (Hidden)"
      },
      {
        id: "rt_grader_sha",
        accessorKey: "rt_grader_sha",
        header: "Development Autograder SHA (Hidden)",
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
        filterFn: (row, filterValue) => {
          if (!row.original.rt_grader_sha) return false;
          const filterString = String(filterValue);
          return (row.original.rt_grader_sha as string).toLowerCase().includes(filterString.toLowerCase());
        }
      }
    ],
    [timeZone, autograder_repo, renderAsLinkToSubmission]
  );
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
    setPageSize
  } = useTable({
    columns,
    initialState: {
      columnFilters: [{ id: "assignment_id", value: assignment_id as string }],
      pagination: {
        pageIndex: 0,
        pageSize: 50
      },
      sorting: [{ id: "name", desc: false }]
    },
    manualPagination: false,
    manualFiltering: false,
    getPaginationRowModel: getPaginationRowModel(),
    pageCount,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    refineCoreProps: {
      resource: "submissions_with_grades_for_assignment_and_regression_test",
      syncWithLocation: false,
      pagination: {
        mode: "off"
      },
      filters: {
        mode: "off"
      },
      meta: {
        select: "*"
      }
    }
  });
  const nRows = getRowCount();
  const pageSize = getState().pagination.pageSize;
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [regrading, setRegrading] = useState<boolean>(false);

  useEffect(() => {
    setPageCount(Math.ceil(nRows / pageSize));
  }, [nRows, pageSize]);
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
                            <Input
                              id={header.id}
                              value={(header.column.getFilterValue() as string) ?? ""}
                              onChange={(e) => {
                                header.column.setFilterValue(e.target.value);
                              }}
                            />
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
          <VStack>
            <Text>Page</Text>
            <Text>
              {getState().pagination.pageIndex + 1} of {getPageCount()}
            </Text>
          </VStack>
          <VStack>
            | Go to page:
            <input
              title="Go to page"
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                setPageIndex(page);
              }}
            />
          </VStack>
          <VStack>
            <Text>Show</Text>
            <NativeSelect.Root title="Select page size">
              <NativeSelect.Field
                value={"" + getState().pagination.pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                }}
              >
                {[25, 50, 100, 200, 500].map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    Show {pageSize}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </VStack>
        </HStack>
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
              const supabase = createClient();
              try {
                await rerunGrader(
                  {
                    submission_ids: selectedRows,
                    class_id: course.classes.id
                  },
                  supabase
                );
                toaster.success({
                  title: "Regrading started",
                  description: "This may take a while..."
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
