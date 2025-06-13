"use client";

import { Button } from "@/components/ui/button";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack, Input, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Row,
  type SortingState,
  useReactTable
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import Papa from "papaparse";
import { useMemo, useState } from "react";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

// View row
type StudentCardAggRow = {
  class_id: number;
  deck_id: number;
  card_id: number;
  student_profile_id: string;
  student_name: string | null;
  prompt_views: number;
  answer_views: number;
  got_it_count: number;
  keep_trying_count: number;
  returned_to_deck: number;
  avg_answer_time_ms: number | null;
  avg_got_it_time_ms: number | null;
  avg_keep_trying_time_ms: number | null;
};

/**
 * @property deckId - The ID of the flashcard deck.
 * @property courseId - The ID of the course.
 */
type StudentCardAnalyticsProps = {
  deckId: string;
  courseId: string;
};

/**
 * @property studentName - The name of the student.
 * @property cardTitle - The title of the flashcard.
 * @property promptViews - Number of times the card prompt was viewed.
 * @property answerViews - Number of times the card answer was viewed.
 * @property gotIt - Number of times the card was marked as "Got It".
 * @property keepTrying - Number of times the card was marked as "Keep Trying".
 * @property returnedToDeck - Number of times the card was returned to the deck.
 * @property avgAnswerTime - Average time from prompt to answer view in seconds.
 * @property avgGotItTime - Average time from answer view to "Got It" in seconds.
 * @property avgKeepTryingTime - Average time from answer view to "Keep Trying" in seconds.
 */
type StudentCardMetrics = {
  studentName: string;
  cardTitle: string;
  promptViews: number;
  answerViews: number;
  gotIt: number;
  keepTrying: number;
  returnedToDeck: number;
  avgAnswerTime: number | string;
  avgGotItTime: number | string;
  avgKeepTryingTime: number | string;
};

/**
 * This component displays detailed analytics for each student's interaction with flashcards in a deck.
 * It shows metrics like view counts, action counts (e.g., "Got It", "Keep Trying"), and average time spent on cards.
 * @param props - The component props.
 * @returns The rendered student card analytics table.
 */
export default function StudentCardAnalytics({ deckId, courseId }: StudentCardAnalyticsProps) {
  const { data: cardsData, isLoading: isLoadingCards } = useList<FlashcardRow>({
    resource: "flashcards",
    filters: [{ field: "deck_id", operator: "eq", value: deckId }],
    queryOptions: { enabled: !!deckId }
  });

  const { data: aggData, isLoading: isLoadingAgg } = useList<StudentCardAggRow>({
    resource: "flashcard_student_card_analytics",
    filters: [
      { field: "deck_id", operator: "eq", value: deckId },
      { field: "class_id", operator: "eq", value: courseId }
    ],
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: !!deckId && !!courseId }
  });

  const analyticsData = useMemo<StudentCardMetrics[]>(() => {
    if (!aggData?.data || !cardsData?.data) {
      return [];
    }

    const cardMap = new Map(cardsData.data.map((card) => [card.id, card.title]));

    return aggData.data.map((row) => {
      return {
        studentName: row.student_name || `User ${row.student_profile_id}`,
        cardTitle: cardMap.get(row.card_id) || `Card ${row.card_id}`,
        promptViews: row.prompt_views,
        answerViews: row.answer_views,
        gotIt: row.got_it_count,
        keepTrying: row.keep_trying_count,
        returnedToDeck: row.returned_to_deck,
        avgAnswerTime: row.avg_answer_time_ms ? (row.avg_answer_time_ms / 1000).toFixed(2) : 0,
        avgGotItTime: row.avg_got_it_time_ms ? (row.avg_got_it_time_ms / 1000).toFixed(2) : 0,
        avgKeepTryingTime: row.avg_keep_trying_time_ms ? (row.avg_keep_trying_time_ms / 1000).toFixed(2) : 0
      };
    });
  }, [aggData, cardsData]);

  const [sorting, setSorting] = useState<SortingState>([{ id: "studentName", desc: false }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const columns = useMemo<ColumnDef<StudentCardMetrics>[]>(
    () => [
      {
        header: "Student",
        accessorKey: "studentName",
        enableColumnFilter: true,
        filterFn: "includesString",
        size: 250
      },
      {
        header: "Card",
        accessorKey: "cardTitle",
        enableColumnFilter: true,
        filterFn: "includesString",
        size: 200
      },
      {
        header: "Prompt Views",
        accessorKey: "promptViews",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "Answer Views",
        accessorKey: "answerViews",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "'Got It' Count",
        accessorKey: "gotIt",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "'Keep Trying' Count",
        accessorKey: "keepTrying",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "Returned to Deck",
        accessorKey: "returnedToDeck",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "Avg. Answer Time (s)",
        accessorKey: "avgAnswerTime",
        size: 100,
        cell: (info) => <Text textAlign="right">{info.getValue<string>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "Avg. 'Got It' Time (s)",
        accessorKey: "avgGotItTime",
        size: 100,
        cell: (info) => <Text textAlign="right">{info.getValue<string>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
      },
      {
        header: "Avg. 'Keep Trying' Time (s)",
        accessorKey: "avgKeepTryingTime",
        size: 110,
        cell: (info) => <Text textAlign="right">{info.getValue<string>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => String(row.getValue(id)).includes(String(filterValue))
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

  if (isLoadingCards || isLoadingAgg) {
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
    a.download = `student_card_analytics_${deckId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentRows = getRowModel().rows;

  if (currentRows.length === 0) {
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
            {currentRows.map((row: Row<StudentCardMetrics>) => (
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
