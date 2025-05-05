"use client";
import Link from "@/components/ui/link";
import { useCourse } from "@/hooks/useAuthState";
import { ActiveSubmissionsWithGradesForAssignment } from "@/utils/supabase/DatabaseTypes";
import { HStack, Box, Text, VStack, NativeSelect, Button, Icon, Table, Input } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useTable } from "@refinedev/react-table";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel
} from "@tanstack/react-table";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FaSort, FaSortUp, FaSortDown, FaCheck, FaTimes } from "react-icons/fa";

export default function AssignmentsTable() {
  const { assignment_id, course_id } = useParams();
  const course = useCourse();
  const timeZone = course.classes.time_zone || "America/New_York";
  const [pageCount, setPageCount] = useState(0);
  const columns = useMemo<ColumnDef<ActiveSubmissionsWithGradesForAssignment>[]>(
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
        id: "name",
        accessorKey: "name",
        header: "Student",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!row.original.name) return false;
          const filterString = String(filterValue).toLowerCase();
          return row.original.name.toLowerCase().includes(filterString);
        }
      },
      {
        id: "groupname",
        accessorKey: "groupname",
        header: "Group"
      },
      {
        id: "late_due_date",
        accessorKey: "late_due_date",
        header: "Late Due Date",
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }
          return <Text>{new TZDate(props.getValue() as string, timeZone).toLocaleString()}</Text>;
        }
      },

      {
        id: "autograder_score",
        accessorKey: "autograder_score",
        header: "Autograder Score"
      },
      {
        id: "total_score",
        accessorKey: "total_score",
        header: "Total Score"
      },
      {
        id: "tweak",
        accessorKey: "tweak",
        header: "Total Score Tweak"
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
        filterFn: (row, id, filterValue) => {
          if (!row.original.created_at) return false;
          const date = new TZDate(row.original.created_at, timeZone);
          const filterString = String(filterValue);
          return date.toLocaleString().includes(filterString);
        }
      },
      {
        id: "gradername",
        accessorKey: "gradername",
        header: "Grader"
      },
      {
        id: "checkername",
        accessorKey: "checkername",
        header: "Checker"
      },
      {
        id: "released",
        accessorKey: "released",
        header: "Released",
        cell: (props) => {
          return props.getValue() ? <Icon as={FaCheck} /> : <Icon as={FaTimes} />;
        }
      }
    ],
    [timeZone]
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
      resource: "submissions_with_grades_for_assignment",
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
  useEffect(() => {
    setPageCount(Math.ceil(nRows / pageSize));
  }, [nRows, pageSize]);
  return (
    <VStack>
      <VStack paddingBottom="55px">
        <Table.Root striped>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row bg="bg.subtle" key={headerGroup.id}>
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
                  <Table.Row key={row.id}>
                    {row
                      .getVisibleCells()
                      .filter((c) => c.column.id !== "assignment_id")
                      .map((cell) => {
                        if (row.original.activesubmissionid === null) {
                          return (
                            <Table.Cell key={cell.id}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </Table.Cell>
                          );
                        }
                        return (
                          <Table.Cell key={cell.id}>
                            <Link
                              href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </Link>
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
            <NativeSelect.Root>
              <NativeSelect.Field
                value={"" + getState().pagination.pageSize}
                onChange={(event) => {
                  console.log(event.target.value);
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
        <HStack></HStack>
      </Box>
    const { assignment_id, course_id } = useParams();
    const course = useCourse();
    const timeZone = course.classes.time_zone || "America/New_York";
    const [pageCount, setPageCount] = useState(0);
    const columns = useMemo<ColumnDef<ActiveSubmissionsWithGradesForAssignment>[]>(() => [
        {
            id: "assignment_id",
            accessorKey: "assignment_id",
            header: "Assignment",
            filterFn: (row, id, filterValue) => {
                return String(row.original.assignment_id) === String(filterValue);
            }
        },
        {
            id: "name",
            accessorKey: "name",
            header: "Student",
            enableColumnFilter: true,
            filterFn: (row, id, filterValue) => {
                if (!row.original.name)
                    return false;
                const filterString = String(filterValue).toLowerCase();
                return row.original.name.toLowerCase().includes(filterString);
            }
        },
        {
            id: "groupname",
            accessorKey: "groupname",
            header: "Group",
        },
        {
            id: "late_due_date",
            accessorKey: "late_due_date",
            header: "Late Due Date",
            cell: (props) => {
                if (props.getValue() === null) {
                    return <Text></Text>
                }
                return <Text>{new TZDate(props.getValue() as string, timeZone).toLocaleString()}</Text>
            }
        },
        
        {
            id: "autograder_score",
            accessorKey: "autograder_score",
            header: "Autograder Score",
        },
        {
            id: "total_score",
            accessorKey: "total_score",
            header: "Total Score",
        },
        {
            id: 'tweak',
            accessorKey: 'tweak',
            header: "Total Score Tweak",
        },
        {
            id: "created_at",
            accessorKey: "created_at",
            header: "Submission Date",
            cell: (props) => {
                if (props.getValue() === null) {
                    return <Text></Text>
                }
                return <Text>{new TZDate(props.getValue() as string, timeZone).toLocaleString()}</Text>
            },
            filterFn: (row, id, filterValue) => {
                if (!row.original.created_at) return false;
                const date = new TZDate(row.original.created_at, timeZone);
                const filterString = String(filterValue);
                return date.toLocaleString().includes(filterString);
            }
        },
        {
            id: "gradername",
            accessorKey: "gradername",
            header: "Grader",
        },
        {
            id: "checkername",
            accessorKey: "checkername",
            header: "Checker",
        },
        {
            id: "released",
            accessorKey: "released",
            header: "Released",
            cell: (props) => {
                return props.getValue() ? <Icon as={FaCheck} /> : <Icon as={FaTimes} />
            }
        }

    ], [timeZone]);
    const {
        getHeaderGroups,
        getRowModel,
        getState,
        getRowCount,
        setPageIndex,
        getCanPreviousPage,
        getCanNextPage,
        nextPage,
        previousPage,
        setPageSize,

    } = useTable({
        columns,
        initialState: {
            columnFilters: [{ id: "assignment_id", value: assignment_id as string }],
            pagination: {
                pageIndex: 0,
                pageSize: 50,
            },
            sorting: [{ id: "name", desc: false }]
        },
        manualPagination: false,
        manualFiltering: false,
        manualSorting: false,
        getPaginationRowModel:  getPaginationRowModel(),
        pageCount,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        refineCoreProps: {
            resource: "submissions_with_grades_for_assignment",
            syncWithLocation: false,
            pagination: {
                mode: "off",
            },
            filters: {
                mode: "off",
            },
            meta: {
                select: "*"
            }
        },
    });
    const nRows = getRowCount();
    const pageSize = getState().pagination.pageSize;
    useEffect(() => {
        setPageCount(Math.ceil(nRows / pageSize));
    }, [nRows, pageSize]);
    return (<VStack>
        <VStack paddingBottom="55px">
            <Table.Root striped>
                <Table.Header>
                    {getHeaderGroups().map((headerGroup) => (
                        <Table.Row bg="bg.subtle" key={headerGroup.id}>
                            {headerGroup.headers.filter(h => h.id !== "assignment_id").map((header) => {
                                return (
                                    <Table.ColumnHeader key={header.id}>
                                        {header.isPlaceholder ? null : (
                                            <>
                                                <Text onClick={header.column.getToggleSortingHandler()}>
                                                    {flexRender(
                                                        header.column.columnDef.header,
                                                        header.getContext(),
                                                    )}
                                                    {{
                                                        asc: <Icon size="md"><FaSortUp /></Icon>,
                                                        desc: <Icon size="md"><FaSortDown /></Icon>,
                                                    }[header.column.getIsSorted() as string] ?? <Icon size="md"><FaSort /></Icon>}
                                                </Text>
                                                <Input
                                                    id={header.id}
                                                    value={
                                                        (header.column.getFilterValue() as string) ?? ""
                                                    }
                                                    onChange={(e) => {
                                                        header.column.setFilterValue(e.target.value)
                                                    }
                                                    }
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
                    {getRowModel().rows//.filter(row => row.getValue("profiles.name") !== undefined)
                        .map((row) => {
                            return (
                                <Table.Row key={row.id}>
                                    {row.getVisibleCells().filter(c => c.column.id !== "assignment_id").map((cell) => {
                                        if (row.original.activesubmissionid === null) {
                                            return <Table.Cell key={cell.id}>{flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}</Table.Cell>
                                        }
                                        return (
                                            <Table.Cell key={cell.id}>
                                                <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`}>
                                                    {flexRender(
                                                        cell.column.columnDef.cell,
                                                        cell.getContext(),
                                                    )}
                                                </Link>
                                            </Table.Cell>
                                        );
                                    })}
                                </Table.Row>
                            );
                        })}
                </Table.Body>
            </Table.Root>
            <HStack>
                <Button
                    onClick={() => setPageIndex(0)}
                    disabled={!getCanPreviousPage()}
                >
                    {"<<"}
                </Button>
                <Button
                    id="previous-button"
                    onClick={() => previousPage()}
                    disabled={!getCanPreviousPage()}
                >
                    {"<"}
                </Button>
                <Button
                    id="next-button"
                    onClick={() => nextPage()}
                    disabled={!getCanNextPage()}
                >
                    {">"}
                </Button>
                <Button
                    onClick={() => setPageIndex(pageCount - 1)}
                    disabled={!getCanNextPage()}
                >
                    {">>"}
                </Button>
                <VStack>
                    <Text>Page</Text>
                    <Text>
                        {getState().pagination.pageIndex + 1} of {pageCount}
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
                    <NativeSelect.Root
                    >
                        <NativeSelect.Field value={'' + getState().pagination.pageSize}
                            onChange={(event) => {
                                console.log(event.target.value);
                                setPageSize(Number(event.target.value));
                            }}>

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
                width: "100%",
            }}>
            <HStack>
            </HStack>
        </Box>
    </VStack>
  );
}
