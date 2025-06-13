"use client";

import { Button } from "@/components/ui/button";
import { Box, HStack, Input, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import {
  ColumnDef,
  ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  Row,
  SortingState,
  useReactTable
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import Papa from "papaparse";
import { useMemo, useState } from "react";

// Row returned by the new `flashcard_student_deck_analytics` view.
type StudentDeckAnalyticsRow = {
  student_profile_id: string;
  name: string | null;
  class_id: number;
  deck_id: number;
  mastered_count: number;
  not_mastered_count: number;
  prompt_views: number;
  answer_views: number;
  returned_to_deck: number;
};

/**
 * @property deckId - The ID of the flashcard deck.
 * @property courseId - The ID of the course.
 */
type StudentDeckAnalyticsProps = {
  deckId: string;
  courseId: string;
};

/**
 * @property studentName - The name of the student.
 * @property masteredCount - Number of cards mastered by the student.
 * @property notMasteredCount - Number of cards not yet mastered by the student.
 * @property promptViews - Total number of times card prompts were viewed by the student across the deck.
 * @property answerViews - Total number of times card answers were viewed by the student across the deck.
 * @property returnedToDeck - Total number of times cards were returned to the deck by the student.
 */
type StudentDeckMetrics = {
  studentName: string;
  masteredCount: number;
  notMasteredCount: number;
  promptViews: number;
  answerViews: number;
  returnedToDeck: number;
};

/**
 * This component displays aggregated analytics for each student's interaction with a flashcard deck.
 * @param props - The component props.
 * @returns The rendered student deck analytics table.
 */
export default function StudentDeckAnalytics({ deckId, courseId }: StudentDeckAnalyticsProps) {
  const { data: viewData, isLoading: isLoadingView } = useList<StudentDeckAnalyticsRow>({
    resource: "flashcard_student_deck_analytics",
    filters: [
      { field: "deck_id", operator: "eq", value: deckId },
      { field: "class_id", operator: "eq", value: courseId }
    ],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: !!deckId && !!courseId }
  });

  const analyticsData = useMemo<StudentDeckMetrics[]>(() => {
    if (!viewData?.data) return [];
    return viewData.data.map((row) => ({
      studentName: row.name || `User ${row.student_profile_id}`,
      masteredCount: row.mastered_count,
      notMasteredCount: row.not_mastered_count,
      promptViews: row.prompt_views,
      answerViews: row.answer_views,
      returnedToDeck: row.returned_to_deck
    }));
  }, [viewData]);

  const [sorting, setSorting] = useState<SortingState>([{ id: "studentName", desc: false }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const columns = useMemo<ColumnDef<StudentDeckMetrics>[]>(
    () => [
      {
        header: "Student",
        accessorKey: "studentName",
        enableColumnFilter: true,
        filterFn: "includesString",
        size: 250
      },
      {
        header: "Cards Mastered",
        accessorKey: "masteredCount",
        size: 100,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          return String(row.getValue(id)).includes(String(filterValue));
        }
      },
      {
        header: "Cards Not Mastered",
        accessorKey: "notMasteredCount",
        size: 100,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          return String(row.getValue(id)).includes(String(filterValue));
        }
      },
      {
        header: "Total Prompt Views",
        accessorKey: "promptViews",
        size: 120,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          return String(row.getValue(id)).includes(String(filterValue));
        }
      },
      {
        header: "Total Answer Views",
        accessorKey: "answerViews",
        size: 120,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          return String(row.getValue(id)).includes(String(filterValue));
        }
      },
      {
        header: "Total 'Returned to Deck'",
        accessorKey: "returnedToDeck",
        size: 120,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          return String(row.getValue(id)).includes(String(filterValue));
        }
      }
    ],
    []
  );

  const table = useReactTable({
    columns,
    data: analyticsData,
    state: {
      sorting,
      columnFilters
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      pagination: { pageSize: 20 }
    },
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
    getPageCount
  } = table;

  if (isLoadingView) {
    return <Spinner />;
  }

  // Export handler
  const handleExportCSV = () => {
    if (!analyticsData.length) return;
    const csv = Papa.unparse(analyticsData);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `student_deck_analytics_${deckId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentRows = getRowModel().rows;

  if (analyticsData.length === 0) {
    return <Text>No student interaction data available for this deck.</Text>;
  }

  return (
    <VStack align="stretch" w="100%">
      {/* Export Button */}
      <HStack justifyContent="flex-end" mb={2}>
        <Button size="sm" colorPalette="green" variant="subtle" onClick={handleExportCSV}>
          Export CSV
        </Button>
      </HStack>
      <Box overflowX="auto">
        <Table.Root striped style={{ tableLayout: "fixed", width: "100%" }}>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader
                    key={header.id}
                    style={{
                      width: `${header.getSize()}px`
                    }}
                  >
                    {header.isPlaceholder ? null : (
                      <VStack align="center" gap={2}>
                        <HStack
                          onClick={header.column.getToggleSortingHandler()}
                          cursor={header.column.getCanSort() ? "pointer" : "default"}
                          title={header.column.getCanSort() ? `Sort by ${header.column.id}` : undefined}
                          gap={1}
                        >
                          <Text fontWeight="bold">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </Text>
                          <Box>
                            {{
                              asc: "🔼",
                              desc: "🔽"
                            }[header.column.getIsSorted() as string] ?? null}
                          </Box>
                        </HStack>
                        {header.column.getCanFilter() && (
                          <Input
                            id={header.id}
                            size="sm"
                            placeholder={`Filter...`}
                            value={(header.column.getFilterValue() as string) ?? ""}
                            onChange={(e) => header.column.setFilterValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()} // Prevent sorting when clicking input
                          />
                        )}
                      </VStack>
                    )}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {currentRows.map((row: Row<StudentDeckMetrics>) => (
              <Table.Row key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <Table.Cell key={cell.id} verticalAlign="top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>

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
          <Button size="sm" onClick={() => setPageIndex(getPageCount() - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
        </HStack>

        <HStack gap={2} alignItems="center">
          <Text fontSize="sm">
            Page {getState().pagination.pageIndex + 1} of {getPageCount()}
          </Text>
          <Text fontSize="sm">|</Text>
          <Text fontSize="sm">Go to page:</Text>
          <Input
            size="sm"
            width="20"
            type="number"
            min="1"
            max={getPageCount()}
            defaultValue={getState().pagination.pageIndex + 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              setPageIndex(page);
            }}
          />
        </HStack>

        <HStack gap={2} alignItems="center">
          <Text fontSize="sm">Show:</Text>
          <Select
            value={{
              value: getState().pagination.pageSize,
              label: `${getState().pagination.pageSize} rows`
            }}
            onChange={(selectedOption: { value: number; label: string } | null) => {
              if (selectedOption) {
                setPageSize(selectedOption.value);
              }
            }}
            options={[10, 20, 50, 100].map((pageSize) => ({
              value: pageSize,
              label: `${pageSize} rows`
            }))}
            size="sm"
            isSearchable={false}
            aria-label="Rows per page"
            chakraStyles={{
              container: (provided) => ({ ...provided, width: "120px" }),
              control: (provided) => ({ ...provided, minHeight: "32px" })
            }}
          />
        </HStack>
      </HStack>

      <Text fontSize="sm" textAlign="center">
        Showing {currentRows.length} of {analyticsData.length} total records
      </Text>
    </VStack>
  );
}
