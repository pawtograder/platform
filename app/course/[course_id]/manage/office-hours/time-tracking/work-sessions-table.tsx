"use client";

import { Box, HStack, Icon, NativeSelect, Table, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatDuration, formatDate } from "@/utils/time-formatting";
import { FaSort, FaSortDown, FaSortUp } from "react-icons/fa";
import Papa from "papaparse";

type WorkSessionWithDetails = {
  id: number;
  help_request_id: number;
  class_id: number;
  ta_profile_id: string;
  started_at: string;
  ended_at: string | null;
  queue_depth_at_start: number | null;
  longest_wait_seconds_at_start: number | null;
  notes: string | null;
  taName: string;
  studentName: string;
  durationSeconds: number;
  helpRequestTitle?: string;
};

type WorkSessionsTableProps = {
  sessions: WorkSessionWithDetails[];
  courseId: number;
};

export default function WorkSessionsTable({ sessions, courseId }: WorkSessionsTableProps) {
  const columns = useMemo<ColumnDef<WorkSessionWithDetails>[]>(
    () => [
      {
        id: "ta",
        header: "TA",
        accessorFn: (row) => row.taName,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.taName) return false;
          return values.some((val) => row.original.taName!.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => {
          return <Text>{row.original.taName}</Text>;
        }
      },
      {
        id: "student",
        header: "Student",
        accessorFn: (row) => row.studentName,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.studentName) return false;
          return values.some((val) => row.original.studentName!.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => {
          return <Text>{row.original.studentName}</Text>;
        }
      },
      {
        id: "date",
        header: "Date",
        accessorFn: (row) => row.started_at,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.started_at) return false;
          const dateStr = formatDate(row.original.started_at);
          return values.some((val) => dateStr.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => formatDate(row.original.started_at)
      },
      {
        id: "help_request",
        header: "Help Request",
        accessorFn: (row) => row.help_request_id,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const requestId = row.original.help_request_id.toString();
          return values.some((val) => requestId.includes(val));
        },
        cell: ({ row }) => (
          <Link href={`/course/${courseId}/manage/office-hours/request/${row.original.help_request_id}`}>
            <Button variant="ghost" size="sm">
              Request #{row.original.help_request_id}
            </Button>
          </Link>
        )
      },
      {
        id: "duration",
        header: "Duration",
        accessorFn: (row) => row.durationSeconds,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const durationStr = formatDuration(row.original.durationSeconds);
          return values.some((val) => durationStr.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => {
          const session = row.original;
          const isActive = !session.ended_at;
          return (
            <HStack gap={1}>
              <Text>{formatDuration(session.durationSeconds)}</Text>
              {isActive && (
                <Box as="span" px={1.5} py={0.5} borderRadius="full" bg="colorPalette.500" color="white" fontSize="xs">
                  Active
                </Box>
              )}
            </HStack>
          );
        }
      },
      {
        id: "queue_depth",
        header: "Queue Depth",
        accessorFn: (row) => row.queue_depth_at_start,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const depth = row.original.queue_depth_at_start;
          if (depth === null) return values.includes("N/A");
          return values.includes(depth.toString());
        },
        cell: ({ row }) => row.original.queue_depth_at_start ?? "N/A"
      },
      {
        id: "wait_context",
        header: "Wait Context",
        accessorFn: (row) => row.longest_wait_seconds_at_start,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const waitSeconds = row.original.longest_wait_seconds_at_start;
          if (waitSeconds === null) return values.includes("N/A");
          const waitStr = formatDuration(waitSeconds);
          return values.some((val) => waitStr.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => {
          const waitSeconds = row.original.longest_wait_seconds_at_start;
          if (waitSeconds === null) return "N/A";
          return formatDuration(waitSeconds);
        }
      },
      {
        id: "notes",
        header: "Notes",
        accessorFn: (row) => row.notes || "",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const notes = row.original.notes || "";
          if (!notes) return values.includes("No notes");
          return values.some((val) => notes.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => row.original.notes || "-"
      }
    ],
    [courseId]
  );

  const table = useReactTable({
    data: sessions,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 50
      },
      sorting: [{ id: "date", desc: true }]
    }
  });

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
  } = table;

  const handleExportCSV = () => {
    // Use getFilteredRowModel() to get all filtered rows (respects filters but not pagination)
    const allRows = table.getFilteredRowModel().rows;
    const rows = allRows.map((row) => {
      const session = row.original;
      return {
        TA: session.taName,
        Student: session.studentName,
        Date: formatDate(session.started_at),
        "Help Request ID": session.help_request_id,
        Duration: formatDuration(session.durationSeconds),
        "Queue Depth": session.queue_depth_at_start ?? "N/A",
        "Wait Context": session.longest_wait_seconds_at_start
          ? formatDuration(session.longest_wait_seconds_at_start)
          : "N/A",
        Notes: session.notes || "",
        "Started At": session.started_at,
        "Ended At": session.ended_at || "Active"
      };
    });

    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `work-sessions-${courseId}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <VStack w="100%" gap={4}>
      <HStack w="100%" justifyContent="flex-end">
        <Button variant="subtle" onClick={handleExportCSV}>
          Export to CSV
        </Button>
      </HStack>
      <Box overflowX="auto" maxW="100vw" w="100%">
        <Table.Root minW="0" w="100%">
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header, colIdx) => (
                  <Table.ColumnHeader
                    key={header.id}
                    bg="bg.muted"
                    style={{
                      position: "sticky",
                      top: 0,
                      left: colIdx === 0 ? 0 : undefined,
                      zIndex: colIdx === 0 ? 21 : 20,
                      minWidth: colIdx === 0 ? 180 : undefined,
                      width: colIdx === 0 ? 180 : undefined
                    }}
                  >
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
                        {header.id === "ta" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              (table.getCoreRowModel()?.rows || [])
                                .reduce((map, row) => {
                                  const taName = row.original.taName;
                                  if (taName && !map.has(taName)) {
                                    map.set(taName, taName);
                                  }
                                  return map;
                                }, new Map())
                                .values()
                            )
                              .sort()
                              .map((name) => ({ label: name, value: name }))}
                            placeholder="Filter by TA..."
                          />
                        )}
                        {header.id === "student" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              (table.getCoreRowModel()?.rows || [])
                                .reduce((map, row) => {
                                  const studentName = row.original.studentName;
                                  if (studentName && !map.has(studentName)) {
                                    map.set(studentName, studentName);
                                  }
                                  return map;
                                }, new Map())
                                .values()
                            )
                              .sort()
                              .map((name) => ({ label: name, value: name }))}
                            placeholder="Filter by student..."
                          />
                        )}
                        {header.id === "date" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              (table.getCoreRowModel()?.rows || [])
                                .reduce((map, row) => {
                                  if (row.original.started_at) {
                                    const dateStr = formatDate(row.original.started_at);
                                    if (!map.has(dateStr)) {
                                      map.set(dateStr, dateStr);
                                    }
                                  }
                                  return map;
                                }, new Map())
                                .values()
                            )
                              .sort()
                              .reverse()
                              .map((date) => ({ label: date, value: date }))}
                            placeholder="Filter by date..."
                          />
                        )}
                        {header.id === "help_request" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              (table.getCoreRowModel()?.rows || [])
                                .reduce((map, row) => {
                                  const requestId = row.original.help_request_id.toString();
                                  if (!map.has(requestId)) {
                                    map.set(requestId, requestId);
                                  }
                                  return map;
                                }, new Map())
                                .values()
                            )
                              .sort((a, b) => parseInt(b) - parseInt(a))
                              .map((id) => ({ label: `Request #${id}`, value: id }))}
                            placeholder="Filter by help request..."
                          />
                        )}
                        {header.id === "duration" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              (table.getCoreRowModel()?.rows || [])
                                .reduce((map, row) => {
                                  const durationStr = formatDuration(row.original.durationSeconds);
                                  if (!map.has(durationStr)) {
                                    map.set(durationStr, durationStr);
                                  }
                                  return map;
                                }, new Map())
                                .values()
                            )
                              .sort()
                              .map((duration) => ({ label: duration, value: duration }))}
                            placeholder="Filter by duration..."
                          />
                        )}
                        {header.id === "queue_depth" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={[
                              ...Array.from(
                                (table.getCoreRowModel()?.rows || [])
                                  .reduce((map, row) => {
                                    const depth = row.original.queue_depth_at_start;
                                    if (depth !== null && !map.has(depth.toString())) {
                                      map.set(depth.toString(), depth.toString());
                                    }
                                    return map;
                                  }, new Map())
                                  .values()
                              )
                                .sort((a, b) => parseInt(a) - parseInt(b))
                                .map((depth) => ({ label: depth, value: depth })),
                              { label: "N/A", value: "N/A" }
                            ]}
                            placeholder="Filter by queue depth..."
                          />
                        )}
                        {header.id === "wait_context" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={[
                              ...Array.from(
                                (table.getCoreRowModel()?.rows || [])
                                  .reduce((map, row) => {
                                    const waitSeconds = row.original.longest_wait_seconds_at_start;
                                    if (waitSeconds !== null) {
                                      const waitStr = formatDuration(waitSeconds);
                                      if (!map.has(waitStr)) {
                                        map.set(waitStr, waitStr);
                                      }
                                    }
                                    return map;
                                  }, new Map())
                                  .values()
                              )
                                .sort()
                                .map((wait) => ({ label: wait, value: wait })),
                              { label: "N/A", value: "N/A" }
                            ]}
                            placeholder="Filter by wait context..."
                          />
                        )}
                        {header.id === "notes" && (
                          <Select
                            isMulti={true}
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={[
                              { label: "No notes", value: "No notes" },
                              ...Array.from(
                                (table.getCoreRowModel()?.rows || [])
                                  .reduce((map, row) => {
                                    const notes = row.original.notes;
                                    if (notes && !map.has(notes)) {
                                      map.set(notes, notes);
                                    }
                                    return map;
                                  }, new Map())
                                  .values()
                              )
                                .slice(0, 20)
                                .map((note) => ({ label: note.substring(0, 50), value: note }))
                            ]}
                            placeholder="Filter by notes..."
                          />
                        )}
                      </>
                    )}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {getRowModel().rows.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={columns.length} bg="bg.subtle">
                  <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                    <Text>No work sessions found</Text>
                  </VStack>
                </Table.Cell>
              </Table.Row>
            ) : (
              getRowModel().rows.map((row, idx) => (
                <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : undefined} _hover={{ bg: "bg.info" }}>
                  {row.getVisibleCells().map((cell, colIdx) => (
                    <Table.Cell
                      key={cell.id}
                      p={0}
                      {...(colIdx === 0
                        ? {
                            bg: "bg.subtle",
                            borderRightWidth: "1px",
                            borderRightStyle: "solid",
                            borderColor: "border.muted",
                            sx: {
                              position: "sticky",
                              left: 0,
                              zIndex: 1
                            }
                          }
                        : {})}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Box>
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
              {[25, 50, 100, 200, 500, 1000].map((pageSize) => (
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
  );
}
